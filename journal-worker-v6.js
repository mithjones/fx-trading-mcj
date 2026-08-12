/**
 * journal-worker-v2.js   —   MCJ trade journal + risk monitor
 *
 * Supersedes journal-worker-additions.js entirely. Merge into your
 * existing fx-proxy Worker.
 *
 * ============ LOCKED DESIGN DECISIONS ============
 *   Account monitored ........ personal only (ftmo recorded, not alerted)
 *   Loss streak .............. any pair, fully-closed trades only
 *   Breakeven (R = 0) ........ NEUTRAL: streak neither breaks nor increments
 *   Daily reset .............. 10:00 Melbourne (session start)
 *   Weekly reset ............. Monday 10:00 Melbourne
 *   Drawdown basis ........... equity vs balance baseline => INCLUDES floating
 *   Alert on floating ........ yes, real-time
 *   Scale-outs ............... supported; trade closes when remaining_lots = 0
 *
 * ============ SETUP ============
 *   1. npm install @block65/webcrypto-web-push
 *      (NOT the `web-push` package - it needs node crypto.createECDH and
 *       https.request, which Workers does not provide even with
 *       nodejs_compat. This one is WebCrypto/fetch based.)
 *   2. wrangler kv:namespace create "TRADE_JOURNAL"
 *      -> add binding TRADE_JOURNAL to wrangler.toml
 *   3. npx web-push generate-vapid-keys   (generate these YOURSELF)
 *      wrangler secret put VAPID_PUBLIC_KEY
 *      wrangler secret put VAPID_PRIVATE_KEY
 *      wrangler secret put VAPID_SUBJECT      e.g. mailto:you@example.com
 *      wrangler secret put MCJ_API_KEY        long random string
 *   4. wrangler deploy
 *
 * ============ KV LAYOUT ============
 *   trade:<ticket>            full trade record incl. deals[]
 *   index:closed              compact array of closed trades (streak source)
 *   context:<SYM>:<bucket>    pre-trade discretionary context
 *   risk:current              cached risk state
 *   risk:baseline:<periodId>  balance snapshot at period start
 *   alert:<epochMs>           alert log
 *   push:<sha256(endpoint)>   push subscription
 *   throttle:<key>            alert de-dupe marker (TTL)
 */


const DAILY_CAP_PCT = -1.0;
const WEEKLY_CAP_PCT = -3.0;
const STREAK_THRESHOLD = 2;
// "Max 2 trades / day" from your Weekly Targets & Rules box.
// Amber once you have used the allowance, red once it is exceeded.
const TRADES_PER_DAY_AMBER = 2;
const TRADES_PER_DAY_RED = 3;
const CONTEXT_MATCH_WINDOW_MS = 90 * 60 * 1000; // 90 min: you wait for M15 BOS
const SESSION_START_HOUR = 10;                   // 10:00 Melbourne
const MEL_TZ = "Australia/Sydney";

// ============================================================
// ROUTER
// ============================================================

async function handleJournalRequest(request, env, path) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MCJ-Key",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  if (!env.TRADE_JOURNAL) return json({ error: "KV namespace TRADE_JOURNAL not bound" }, 500, cors);

  // Auth on every route.
  // HONEST CAVEAT: the browser must also send this key, and GitHub Pages
  // serves your JS publicly - so anyone reading page source can find it.
  // It genuinely protects the MT5 write path (key lives on your VPS) and
  // stops casual scraping, but it is NOT real security for the read path.
  // For that you'd need Cloudflare Access or a login in front of the Suite.
  if (!env.MCJ_API_KEY) return json({ error: "MCJ_API_KEY secret not set" }, 500, cors);
  if (!safeEqual(request.headers.get("X-MCJ-Key") || "", env.MCJ_API_KEY))
    return json({ error: "Unauthorized" }, 401, cors);

  try {
    if (path === "/trade" && request.method === "POST") return await postTrade(request, env, cors);
    if (path === "/trade/deal" && request.method === "POST") return await postDeal(request, env, cors);
    if (path === "/heartbeat" && request.method === "POST") return await postHeartbeat(request, env, cors);
    if (path === "/context" && request.method === "POST") return await postContext(request, env, cors);
    if (path === "/context/backfill" && request.method === "POST") return await postContextBackfill(request, env, cors);
    if (path === "/admin/reset" && request.method === "POST") return await postReset(request, env, cors);
    if (path === "/alert" && request.method === "POST") return await postPriceAlert(request, env, cors);
    if (path === "/journal" && request.method === "GET") return await getJournal(request, env, cors);
    if (path === "/executions" && request.method === "GET") return await getExecutions(request, env, cors);
    if (path === "/risk" && request.method === "GET") return await getRisk(env, cors);
    if (path === "/push/subscribe" && request.method === "POST") return await postSubscribe(request, env, cors);
    return json({ error: "Not found" }, 404, cors);
  } catch (err) {
    console.error("MCJ Worker error", err && err.stack ? err.stack : err);
    return json({ error: "Internal error", detail: String(err) }, 500, cors);
  }
}

// ============================================================
// TRADE OPEN
// ============================================================

async function postTrade(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);

  const err = validateOpen(b);
  if (err) return json({ error: err }, 422, cors);

  const key = `trade:${b.ticket}`;
  const existing = await env.TRADE_JOURNAL.get(key);
  // 409 is treated as success by the EA (idempotent retry), so a duplicate
  // send after a timeout does not wedge the queue or double-count.
  if (existing) return json({ status: "already_exists", ticket: b.ticket }, 409, cors);

  const record = {
    ticket: String(b.ticket),
    account: b.account || "personal",
    symbol: normalizeSymbol(b.symbol),
    raw_symbol: b.raw_symbol || b.symbol,
    direction: b.direction,
    entry_time: b.entry_time,
    entry_price: b.entry_price,
    lot_size: b.lot_size,
    original_sl: b.original_sl,
    tp_price: b.tp_price ?? null,
    risk_percent: typeof b.risk_percent === "number" && b.risk_percent > 0 ? b.risk_percent : null,
    deals: [],
    closed: false,
    exit_time: null,
    exit_price: null,
    total_pnl: 0,
    r_multiple: null,
  };

  await env.TRADE_JOURNAL.put(key, JSON.stringify(record));

  // Daily trade-count rule is evaluated on OPEN, not close - the warning is
  // only useful before you place the next trade.
  if (record.account === "personal") {
    await appendOpenedIndex(env, record);
    await recalculateRisk(env, {});
  }

  return json({ status: "created", ticket: record.ticket }, 201, cors);
}

// ============================================================
// CLOSING DEAL (partial or full)
// ============================================================

async function postDeal(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);

  const err = validateDeal(b);
  if (err) return json({ error: err }, 422, cors);

  const key = `trade:${b.ticket}`;
  const raw = await env.TRADE_JOURNAL.get(key);
  if (!raw) {
    // Open event lost or not yet consistent. Record an orphan so the deal
    // is never silently dropped; the Suite flags these for manual review.
    await env.TRADE_JOURNAL.put(`orphan:${b.deal_id}`, JSON.stringify(b));
    return json({ error: `No open trade for ticket ${b.ticket}; stored as orphan` }, 404, cors);
  }

  const t = JSON.parse(raw);

  // Idempotent: same deal_id twice (EA retry) must not double-count P&L.
  if (t.deals.some((d) => d.deal_id === String(b.deal_id)))
    return json({ status: "duplicate_ignored", deal_id: b.deal_id }, 409, cors);

  t.deals.push({
    deal_id: String(b.deal_id),
    time: b.deal_time,
    price: b.deal_price,
    lots: b.deal_lots,
    pnl: b.deal_pnl,
    reason: b.reason || "close",
  });

  if (typeof b.original_sl === "number" && b.original_sl > 0 && !t.original_sl)
    t.original_sl = b.original_sl;

  t.total_pnl = round2(t.deals.reduce((s, d) => s + d.pnl, 0));

  const fullyClosed = Number(b.remaining_lots) <= 0.0000001;
  if (fullyClosed) {
    t.closed = true;
    t.exit_time = b.deal_time;
    // Volume-weighted average exit across all scale-outs.
    const totLots = t.deals.reduce((s, d) => s + d.lots, 0);
    t.exit_price = totLots > 0
      ? round5(t.deals.reduce((s, d) => s + d.price * d.lots, 0) / totLots)
      : b.deal_price;
    t.closed_lots = round2(totLots);
    t.r_multiple = computeRMultiple(t);
  }

  await env.TRADE_JOURNAL.put(key, JSON.stringify(t));

  if (fullyClosed) {
    // Append to the compact index. This is the streak source of truth:
    // it avoids listing 1000s of keys AND sidesteps KV eventual
    // consistency, because we merge this trade in memory before computing.
    await appendClosedIndex(env, t);
    await recalculateRisk(env, { justClosed: t });
  }

  return json({ status: fullyClosed ? "closed" : "partial_recorded", ticket: t.ticket }, 200, cors);
}

/**
 * R-multiple against the ORIGINAL stop, not the trailed one.
 * Uses money risk (lots x stop distance) so scale-outs are handled:
 * planned risk is the full initial position to its initial stop.
 */
function computeRMultiple(t) {
  if (!t.original_sl || t.original_sl <= 0) return null;
  const stopDist = Math.abs(t.entry_price - t.original_sl);
  if (stopDist <= 0) return null;

  // Risk in price*lots terms; P&L is in account currency, so scale by the
  // ratio of realised move to stop distance, weighted by lots closed.
  const totLots = t.deals.reduce((s, d) => s + d.lots, 0);
  if (totLots <= 0) return null;

  const sign = t.direction === "buy" ? 1 : -1;
  let weightedR = 0;
  for (const d of t.deals) {
    const move = sign * (d.price - t.entry_price);
    weightedR += (move / stopDist) * (d.lots / t.lot_size);
  }
  return round2(weightedR);
}

// ============================================================
// HEARTBEAT (equity => floating drawdown)
// ============================================================

async function postHeartbeat(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);
  if (typeof b.equity !== "number" || typeof b.balance !== "number")
    return json({ error: "balance and equity must be numbers" }, 422, cors);

  const account = b.account || "personal";
  const hbKey = `heartbeat:${account}`;

  // Heartbeats arrive constantly but usually say the same thing. Only write
  // when equity/balance actually moved, or when the stored one is going stale
  // (so heartbeat_stale stays meaningful). Cuts most of the write volume.
  const prevRaw = await env.TRADE_JOURNAL.get(hbKey);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const ageMs = prev ? Date.now() - new Date(prev.received_at).getTime() : Infinity;
  const moved =
    !prev ||
    Math.abs((prev.equity || 0) - b.equity) >= 0.01 ||
    Math.abs((prev.balance || 0) - b.balance) >= 0.01 ||
    (prev.open_positions || 0) !== (b.open_positions || 0);

  if (moved || ageMs > 8 * 60 * 1000) {
    await env.TRADE_JOURNAL.put(hbKey, JSON.stringify({ ...b, received_at: new Date().toISOString() }));
  } else {
    return json({ status: "unchanged" }, 200, cors);
  }

  if (account !== "personal") return json({ status: "recorded" }, 200, cors);

  await ensureBaseline(env, "day", dayPeriodId(), b.balance);
  await ensureBaseline(env, "week", weekPeriodId(), b.balance);
  await recalculateRisk(env, { heartbeat: b });

  return json({ status: "recorded" }, 200, cors);
}

/**
 * Baseline = account balance at the start of the period. Drawdown is then
 * (equity - baseline) / baseline, which naturally includes floating P&L,
 * commission and swap - no risk% x R approximation needed.
 *
 * If the VPS was offline at 10:00 the first heartbeat of the period sets
 * the baseline late; we flag that rather than pretending it's exact.
 */
async function ensureBaseline(env, kind, periodId, balance) {
  const key = `risk:baseline:${kind}:${periodId}`;
  const existing = await env.TRADE_JOURNAL.get(key);
  if (existing) return JSON.parse(existing);

  const expectedStart = kind === "day" ? dayStartMs() : weekStartMs();
  const inferred = Date.now() - expectedStart > 10 * 60 * 1000;

  const baseline = {
    balance,
    period_id: periodId,
    set_at: new Date().toISOString(),
    inferred, // true => baseline captured late, treat DD% as approximate
  };
  // 35 days TTL: long enough for weekly, self-cleaning.
  await env.TRADE_JOURNAL.put(key, JSON.stringify(baseline), { expirationTtl: 35 * 86400 });
  return baseline;
}

// ============================================================
// RISK ENGINE
// ============================================================

/**
 * KV FREE TIER: 1,000 writes/day. Recomputing-and-persisting on every read
 * blew that cap within hours. Reads are cheap (100k/day), so state is now
 * persisted ONLY when an actual event arrives (trade, deal, heartbeat).
 * GET /risk passes persist:false and simply computes from what's stored.
 */
async function recalculateRisk(env, opts = {}) {
  const persist = opts.persist !== false;
  const prevRaw = await env.TRADE_JOURNAL.get("risk:current");
  const prev = prevRaw ? JSON.parse(prevRaw) : defaultRisk();

  const streak = await computeStreak(env, opts.justClosed);

  const hbRaw = opts.heartbeat
    ? JSON.stringify(opts.heartbeat)
    : await env.TRADE_JOURNAL.get("heartbeat:personal");
  const hb = hbRaw ? JSON.parse(hbRaw) : null;

  const dayId = dayPeriodId();
  const weekId = weekPeriodId();
  const dayBase = await env.TRADE_JOURNAL.get(`risk:baseline:day:${dayId}`);
  const weekBase_ = await env.TRADE_JOURNAL.get(`risk:baseline:week:${weekId}`);

  const dailyPct = pctFromBaseline(hb, dayBase);
  const weeklyPct = pctFromBaseline(hb, weekBase_);

  // Breach flags reset on period rollover.
  let dailyBreached = prev.day_period === dayId ? prev.daily_breached : false;
  let weeklyBreached = prev.week_period === weekId ? prev.weekly_breached : false;
  let alertedStreak = streak === 0 ? 0 : prev.last_alerted_streak || 0;
  let alertedCount = prev.day_period === dayId ? prev.last_alerted_count || 0 : 0;

  const tradesToday = await computeTradesToday(env);
  const week = await computeWeekBreakdown(env);

  const fire = [];

  // Amber at the limit, red past it. Only alert on each new count once.
  if (tradesToday >= TRADES_PER_DAY_RED && alertedCount < TRADES_PER_DAY_RED) {
    fire.push({
      type: "trade_count_exceeded",
      severity: "critical",
      message: `${tradesToday} trades today — over your 2/day limit. Stop trading for the session.`,
    });
    alertedCount = tradesToday;
  } else if (tradesToday === TRADES_PER_DAY_AMBER && alertedCount < TRADES_PER_DAY_AMBER) {
    fire.push({
      type: "trade_count_limit",
      severity: "warning",
      message: `2 trades today — daily allowance used. No more entries this session.`,
    });
    alertedCount = TRADES_PER_DAY_AMBER;
  }

  if (streak >= STREAK_THRESHOLD && streak > alertedStreak) {
    fire.push({
      type: "loss_streak",
      severity: "warning",
      message: `${streak} consecutive losses — review position size before the next entry.`,
    });
    alertedStreak = streak;
  }

  if (dailyPct !== null && dailyPct <= DAILY_CAP_PCT && !dailyBreached) {
    fire.push({
      type: "daily_drawdown",
      severity: "critical",
      message: `Daily drawdown ${dailyPct}% (incl. open positions) — 1% cap reached.`,
    });
    dailyBreached = true;
  }

  if (weeklyPct !== null && weeklyPct <= WEEKLY_CAP_PCT && !weeklyBreached) {
    fire.push({
      type: "weekly_drawdown",
      severity: "critical",
      message: `Weekly drawdown ${weeklyPct}% (incl. open positions) — 3% cap reached.`,
    });
    weeklyBreached = true;
  }

  // Figures the Suite's yellow strip and Risk Manager tab display directly,
  // computed here so there is exactly one source of truth for them.
  const balanceForSizing = hb ? hb.balance : null;
  const weekBase = weekBaseRawForCalc(weekBase_);
  const display = {
    balance: balanceForSizing,
    risk_per_trade: balanceForSizing ? round2((balanceForSizing * 0.5) / 100) : null,
    remaining_dd: weekBase && hb ? round2(Math.max(0, weekBase * 0.03 + (hb.equity - weekBase))) : null,
    week_pnl: weekBase && hb ? round2(hb.equity - weekBase) : null,
  };

  const state = {
    streak,
    trades_today: tradesToday,
    trades_per_day_limit: TRADES_PER_DAY_AMBER,
    week,
    display,
    daily_pnl_percent: dailyPct,
    weekly_pnl_percent: weeklyPct,
    equity: hb ? hb.equity : null,
    balance: hb ? hb.balance : null,
    floating_pnl: hb ? hb.floating_pnl : null,
    open_positions: hb ? hb.open_positions : null,
    heartbeat_at: hb ? hb.received_at || hb.at : null,
    // Threshold must sit comfortably above the heartbeat interval (300s) or the
    // status flickers to stale on every cycle. 12 min = ~2.5 missed beats, which
    // genuinely means the EA or VPS has stopped talking.
    heartbeat_stale: hb ? Date.now() - new Date(hb.received_at || hb.at).getTime() > 12 * 60 * 1000 : true,
    daily_baseline_inferred: dayBase ? JSON.parse(dayBase).inferred : null,
    day_period: dayId,
    week_period: weekId,
    daily_breached: dailyBreached,
    weekly_breached: weeklyBreached,
    last_alerted_streak: alertedStreak,
    last_alerted_count: alertedCount,
    updated_at: new Date().toISOString(),
  };

  if (persist) {
    // Skip the write when nothing meaningful moved - saves the bulk of the quota.
    const changed =
      prev.streak !== state.streak ||
      prev.trades_today !== state.trades_today ||
      prev.daily_pnl_percent !== state.daily_pnl_percent ||
      prev.weekly_pnl_percent !== state.weekly_pnl_percent ||
      prev.daily_breached !== state.daily_breached ||
      prev.weekly_breached !== state.weekly_breached ||
      prev.last_alerted_streak !== state.last_alerted_streak ||
      prev.last_alerted_count !== state.last_alerted_count ||
      prev.day_period !== state.day_period ||
      prev.week_period !== state.week_period;
    if (changed) await env.TRADE_JOURNAL.put("risk:current", JSON.stringify(state));
  }

  for (const a of fire) await storeAlert(env, { ...a, symbol: null, triggered_at: new Date().toISOString() });
  return state;
}

/**
 * Streak over fully-closed personal trades, newest first.
 * Breakeven (R = 0) is NEUTRAL: it neither breaks nor extends the run.
 */
async function computeStreak(env, justClosed) {
  const raw = await env.TRADE_JOURNAL.get("index:closed");
  let list = raw ? JSON.parse(raw) : [];

  if (justClosed && !list.some((x) => x.ticket === justClosed.ticket)) {
    list = list.concat([
      {
        ticket: justClosed.ticket,
        account: justClosed.account,
        exit_time: justClosed.exit_time,
        r_multiple: justClosed.r_multiple,
        total_pnl: justClosed.total_pnl,
      },
    ]);
  }

  const closed = list
    .filter((x) => (x.account || "personal") === "personal")
    .sort((a, b) => new Date(a.exit_time) - new Date(b.exit_time));

  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const outcome = outcomeOf(closed[i]);
    if (outcome === "loss") streak++;
    else if (outcome === "win") break;
    // breakeven => skip, keep scanning backwards
  }
  return streak;
}

/**
 * Prefer R-multiple; fall back to P&L when the original stop was unknown.
 * A near-zero R is treated as breakeven rather than a marginal loss.
 */
function outcomeOf(t) {
  const r = t.r_multiple;
  if (typeof r === "number") {
    if (Math.abs(r) < 0.05) return "breakeven";
    return r < 0 ? "loss" : "win";
  }
  if (typeof t.total_pnl === "number") {
    if (t.total_pnl === 0) return "breakeven";
    return t.total_pnl < 0 ? "loss" : "win";
  }
  return "breakeven";
}

/**
 * Every position OPENED is one trade for rule purposes - scaling out of a
 * single position must not read as three trades against your 2/day limit.
 * Counted from the open index, keyed on entry_time, in the 10:00-anchored day.
 */
async function computeTradesToday(env) {
  const raw = await env.TRADE_JOURNAL.get("index:opened");
  const list = raw ? JSON.parse(raw) : [];
  const from = dayStartMs();
  return list.filter(
    (x) => (x.account || "personal") === "personal" && new Date(x.entry_time).getTime() >= from
  ).length;
}

async function appendOpenedIndex(env, t) {
  const raw = await env.TRADE_JOURNAL.get("index:opened");
  const list = raw ? JSON.parse(raw) : [];
  if (list.some((x) => x.ticket === t.ticket)) return;
  list.push({ ticket: t.ticket, account: t.account, symbol: t.symbol, entry_time: t.entry_time });
  await env.TRADE_JOURNAL.put("index:opened", JSON.stringify(list.slice(-500)));
}

/**
 * Mon-Fri breakdown for the Week Trade Tracker. Days are indexed 0-4 from
 * the Monday 10:00 Melbourne week start, matching the Suite's WDAYS order.
 * pct is per-trade account % so it can be shown on each W/L/B dot.
 */
async function computeWeekBreakdown(env) {
  const raw = await env.TRADE_JOURNAL.get("index:closed");
  const list = raw ? JSON.parse(raw) : [];
  const weekStart = weekStartMs();
  const baseRaw = await env.TRADE_JOURNAL.get(`risk:baseline:week:${weekPeriodId()}`);
  const base = baseRaw ? JSON.parse(baseRaw).balance : null;

  const days = Array.from({ length: 5 }, () => ({ wins: 0, losses: 0, be: 0, trades: 0, pnl: 0, entries: [] }));

  for (const t of list) {
    if ((t.account || "personal") !== "personal") continue;
    const exitMs = new Date(t.exit_time).getTime();
    const idx = Math.floor((exitMs - weekStart) / 86400000);
    if (idx < 0 || idx > 4) continue;

    const d = days[idx];
    const outcome = outcomeOf(t);
    if (outcome === "loss") d.losses++;
    else if (outcome === "win") d.wins++;
    else d.be++;
    d.trades++;
    d.pnl = round2(d.pnl + (t.total_pnl || 0));
    d.entries.push({
      type: outcome === "loss" ? "loss" : outcome === "win" ? "win" : "be",
      pct: base ? round2(((t.total_pnl || 0) / base) * 100) : 0,
      symbol: t.symbol,
      r: t.r_multiple,
    });
  }

  const totals = days.reduce(
    (a, d) => ({
      wins: a.wins + d.wins, losses: a.losses + d.losses, be: a.be + d.be,
      trades: a.trades + d.trades, pnl: round2(a.pnl + d.pnl),
    }),
    { wins: 0, losses: 0, be: 0, trades: 0, pnl: 0 }
  );
  totals.win_rate = totals.trades > 0 ? Math.round((totals.wins / totals.trades) * 100) : null;
  totals.pct = base ? round2((totals.pnl / base) * 100) : null;

  return { days, totals, week_start: new Date(weekStart).toISOString() };
}

async function appendClosedIndex(env, t) {
  const raw = await env.TRADE_JOURNAL.get("index:closed");
  const list = raw ? JSON.parse(raw) : [];
  if (list.some((x) => x.ticket === t.ticket)) return;

  list.push({
    ticket: t.ticket,
    account: t.account,
    symbol: t.symbol,
    exit_time: t.exit_time,
    r_multiple: t.r_multiple,
    total_pnl: t.total_pnl,
  });
  // Keep it bounded; streak only ever needs the recent tail.
  const trimmed = list.slice(-500);
  await env.TRADE_JOURNAL.put("index:closed", JSON.stringify(trimmed));
}

function pctFromBaseline(hb, baselineRaw) {
  if (!hb || !baselineRaw) return null;
  const base = JSON.parse(baselineRaw).balance;
  if (!base || base <= 0) return null;
  return round2(((hb.equity - base) / base) * 100);
}

function defaultRisk() {
  return {
    streak: 0,
    trades_today: 0,
    last_alerted_count: 0,
    daily_pnl_percent: null,
    weekly_pnl_percent: null,
    daily_breached: false,
    weekly_breached: false,
    last_alerted_streak: 0,
    day_period: null,
    week_period: null,
  };
}

// ============================================================
// CONTEXT
// ============================================================

async function postContext(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);

  const err = validateContext(b);
  if (err) return json({ error: err }, 422, cors);

  const sym = normalizeSymbol(b.symbol);
  const epoch = Math.floor(new Date(b.timestamp_gmt).getTime() / 1000);
  const bucket = Math.round(epoch / 300) * 300;
  const record = { ...b, symbol: sym, alignment: alignmentOf(b.position), consumed_by: null };

  await env.TRADE_JOURNAL.put(`context:${sym}:${bucket}`, JSON.stringify(record));
  return json({ status: "created", symbol: sym }, 201, cors);
}

/**
 * Attach context directly to a known ticket.
 *
 * Time-window matching is fragile: you score the zone, then wait for M15
 * confirmation, so the gap between scoring and entry is unpredictable. This
 * sidesteps it - the Suite sees a trade with no context, reads the checklist
 * state for that pair, and attaches it BY TICKET. No guessing.
 */
async function postContextBackfill(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);
  if (!b.ticket) return json({ error: "ticket is required" }, 422, cors);

  const err = validateContext({ ...b, timestamp_gmt: b.timestamp_gmt || new Date().toISOString() });
  if (err) return json({ error: err }, 422, cors);

  const key = `trade:${b.ticket}`;
  const raw = await env.TRADE_JOURNAL.get(key);
  if (!raw) return json({ error: `No trade found for ticket ${b.ticket}` }, 404, cors);

  const t = JSON.parse(raw);
  t.context = {
    ...b,
    symbol: normalizeSymbol(b.symbol || t.symbol),
    alignment: alignmentOf(b.position),
    attached_at: new Date().toISOString(),
    method: "backfill",
  };
  await env.TRADE_JOURNAL.put(key, JSON.stringify(t));
  return json({ status: "attached", ticket: b.ticket }, 200, cors);
}

/** Wipe test data before going live. Push subscriptions are preserved. */
async function postReset(request, env, cors) {
  const b = await parseJson(request);
  if (!b || b.confirm !== "DELETE ALL MCJ DATA")
    return json({ error: 'Send {"confirm":"DELETE ALL MCJ DATA"} to proceed' }, 400, cors);

  let deleted = 0;
  for (const prefix of ["trade:", "context:", "alert:", "alerts:", "risk:", "orphan:", "index:", "heartbeat:", "throttle:"]) {
    const keys = await listAll(env, prefix);
    for (const k of keys) { await env.TRADE_JOURNAL.delete(k); deleted++; }
  }
  return json({ status: "reset", keys_deleted: deleted }, 200, cors);
}

/**
 * Date-filtered execution records for the Executions tab.
 *
 * Reads index:opened (which already carries entry_time) to decide WHICH tickets
 * fall in range, then fetches only those records. The existing /journal handler
 * lists every trade: key and slices, which is O(all) per request; this is O(hits)
 * and needs no re-keying of the existing trade:<ticket> scheme.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (inclusive, Melbourne dates)
 *        ?account=personal|ftmo           (optional)
 */
async function getExecutions(request, env, cors) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const account = url.searchParams.get("account") || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return json({ error: "from and to are required as YYYY-MM-DD" }, 422, cors);

  const raw = await env.TRADE_JOURNAL.get("index:opened");
  const index = raw ? JSON.parse(raw) : [];

  // entry_time is broker GMT+3; the tab filters on Melbourne dates, so convert
  // before comparing rather than string-slicing the ISO value.
  function melDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  }

  const hits = index.filter((x) => {
    if (account && x.account !== account) return false;
    const dt = melDate(x.entry_time);
    return dt && dt >= from && dt <= to;
  });

  const records = (
    await Promise.all(hits.map(async (x) => {
      const v = await env.TRADE_JOURNAL.get(`trade:${x.ticket}`);
      return v ? JSON.parse(v) : null;
    }))
  ).filter(Boolean);

  records.sort((a, b) => String(b.entry_time).localeCompare(String(a.entry_time)));

  return json({
    from, to,
    count: records.length,
    scanned: index.length,
    trades: records,
  }, 200, cors);
}

async function getJournal(request, env, cors) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

  const tradeKeys = await listAll(env, "trade:");
  const trades = (
    await Promise.all(tradeKeys.slice(-limit).map(async (k) => {
      const v = await env.TRADE_JOURNAL.get(k);
      return v ? JSON.parse(v) : null;
    }))
  ).filter(Boolean);

  // Contexts attached by ticket live inside the trade record, so only pay for
  // the context list() when something actually still needs matching.
  const needsMatching = trades.some((t) => !t.context);
  const ctxKeys = needsMatching ? await listAll(env, "context:") : [];
  const contexts = (
    await Promise.all(ctxKeys.map(async (k) => {
      const v = await env.TRADE_JOURNAL.get(k);
      return v ? JSON.parse(v) : null;
    }))
  ).filter(Boolean);

  // Match nearest unconsumed context per trade so two trades on the same
  // pair can't both claim the same pre-trade analysis.
  const used = new Set();
  const sorted = trades.slice().sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
  const merged = sorted.map((t) => {
    const entry = new Date(t.entry_time).getTime();
    let best = null, bestDiff = Infinity, bestId = null;

    for (const c of contexts) {
      const id = `${c.symbol}:${c.timestamp_gmt}`;
      if (used.has(id)) continue;
      if (c.symbol !== t.symbol) continue;
      // Context must precede or coincide with entry, never follow it.
      const diff = entry - new Date(c.timestamp_gmt).getTime();
      if (diff >= -60000 && diff <= CONTEXT_MATCH_WINDOW_MS && diff < bestDiff) {
        best = c; bestDiff = diff; bestId = id;
      }
    }
    if (bestId) used.add(bestId);
    // A context attached by ticket always wins over a time-window guess.
    const ctx = t.context || best;
    return { ...t, context: ctx, context_missing: !ctx };
  });

  return json({ trades: merged.reverse(), count: merged.length }, 200, cors);
}

async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  // KV list() caps at 1000 per page - must paginate or data silently truncates.
  do {
    const page = await env.TRADE_JOURNAL.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

// ============================================================
// ALERTS
// ============================================================

async function postPriceAlert(request, env, cors) {
  const b = await parseJson(request);
  if (!b) return json({ error: "Invalid JSON" }, 400, cors);
  if (typeof b.symbol !== "string" || !b.symbol) return json({ error: "symbol required" }, 422, cors);
  if (typeof b.message !== "string" || !b.message) return json({ error: "message required" }, 422, cors);
  if (!isIso(b.triggered_at)) return json({ error: "triggered_at must be ISO 8601" }, 422, cors);

  await storeAlert(env, {
    type: "price_alert",
    severity: "info",
    symbol: normalizeSymbol(b.symbol),
    message: b.message,
    price: typeof b.price === "number" ? b.price : null,
    triggered_at: b.triggered_at,
  });
  return json({ status: "logged" }, 201, cors);
}

/**
 * Every alert is logged. Push is throttled per type+symbol so a chatty
 * price-alert set can't turn into notification spam. Risk alerts get a
 * short window; price alerts a longer one.
 */
async function storeAlert(env, a) {
  const record = { ...a, triggered_at: a.triggered_at || new Date().toISOString() };

  const list = await readAlerts(env);
  list.unshift(record);
  await env.TRADE_JOURNAL.put("alerts:recent", JSON.stringify(list.slice(0, 50)));

  // Throttle is held in the same key rather than its own, to save writes.
  const throttleSecs = record.type === "price_alert" ? 300 : 60;
  const sameKind = list.find(
    (x, i) => i > 0 && x.type === record.type && (x.symbol || null) === (record.symbol || null)
  );
  if (sameKind && Date.now() - new Date(sameKind.triggered_at).getTime() < throttleSecs * 1000) return;

  await sendPushToAll(env, titleFor(record.type), record.message);
}

function titleFor(type) {
  return {
    loss_streak: "MCJ — Loss Streak",
    daily_drawdown: "MCJ — Daily Cap Hit",
    weekly_drawdown: "MCJ — Weekly Cap Hit",
    trade_count_limit: "MCJ — Daily Limit Reached",
    trade_count_exceeded: "MCJ — Daily Limit Exceeded",
    price_alert: "MCJ — Price Alert",
  }[type] || "MCJ Alert";
}

/** Baseline balance from a stored baseline record, or null. */
function weekBaseRawForCalc(raw) {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw).balance;
    return typeof b === "number" && b > 0 ? b : null;
  } catch {
    return null;
  }
}

async function getRisk(env, cors) {
  // Read-only: computes fresh figures but writes nothing. Alerts fire from
  // events (trade close, heartbeat), never from someone loading the page.
  const risk = await recalculateRisk(env, { persist: false });
  const alerts = await readAlerts(env);
  return json({ risk, alerts, caps: { daily: DAILY_CAP_PCT, weekly: WEEKLY_CAP_PCT } }, 200, cors);
}

/**
 * Alerts live in ONE rolling key rather than one key each. The old scheme cost
 * a write per alert plus a list() per read, and list() is capped at 1,000/day.
 */
async function readAlerts(env) {
  const raw = await env.TRADE_JOURNAL.get("alerts:recent");
  return raw ? JSON.parse(raw) : [];
}

// ============================================================
// PUSH
// ============================================================

async function postSubscribe(request, env, cors) {
  const b = await parseJson(request);
  if (!b || !b.endpoint || !b.keys || !b.keys.p256dh || !b.keys.auth)
    return json({ error: "Invalid push subscription" }, 422, cors);

  const key = `push:${await sha256Hex(b.endpoint)}`;
  await env.TRADE_JOURNAL.put(key, JSON.stringify(b));
  return json({ status: "subscribed" }, 201, cors);
}

/**
 * Web push with NO npm dependency - uses only WebCrypto, which Cloudflare
 * Workers provides natively. This is what makes the Worker pasteable into
 * the dashboard editor.
 *
 * We send a push with NO PAYLOAD. Encrypting a payload requires ECDH key
 * agreement plus AES-GCM, which is a lot of fragile code. A payload-less
 * push just wakes the service worker, which then fetches /risk itself and
 * shows the current alert - simpler, and the notification is always current
 * rather than a snapshot from when it was queued.
 *
 * All that is needed is a signed VAPID JWT in the Authorization header.
 */
async function sendPushToAll(env, title, body) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.error("MCJ: VAPID secrets missing, push skipped");
    return;
  }

  const keys = await listAll(env, "push:");
  if (keys.length === 0) return;

  await Promise.all(
    keys.map(async (k) => {
      const raw = await env.TRADE_JOURNAL.get(k);
      if (!raw) return;
      const sub = JSON.parse(raw);
      try {
        const jwt = await makeVapidJwt(new URL(sub.endpoint).origin, env);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            TTL: "3600",
            Urgency: "high",
            Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
          },
        });
        // 404/410 = subscription dead (permission revoked, browser reset)
        if (res.status === 404 || res.status === 410) {
          await env.TRADE_JOURNAL.delete(k);
        } else if (!res.ok) {
          console.error("MCJ: push failed", res.status, await res.text());
        }
      } catch (err) {
        console.error("MCJ: push error", err);
      }
    })
  );
}

/** ES256-signed JWT proving to the push service that we own the VAPID key. */
async function makeVapidJwt(audience, env) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // spec allows max 24h
    sub: env.VAPID_SUBJECT,
  };

  const signingInput =
    b64urlFromString(JSON.stringify(header)) + "." + b64urlFromString(JSON.stringify(payload));

  const key = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  // WebCrypto returns raw r||s (IEEE P1363), which is exactly ES256's format.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  return signingInput + "." + b64urlFromBytes(new Uint8Array(sig));
}

/**
 * The generator gives a 32-byte private scalar and a 65-byte uncompressed
 * public point (0x04 || x || y). WebCrypto wants those as JWK components.
 */
async function importVapidPrivateKey(privB64, pubB64) {
  const pub = b64urlToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID public key must be 65-byte uncompressed P-256");

  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    x: b64urlFromBytes(pub.slice(1, 33)),
    y: b64urlFromBytes(pub.slice(33, 65)),
    ext: true,
  };

  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function b64urlToBytes(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ============================================================
// TIME — Melbourne session boundaries
// ============================================================

/**
 * Robust tz offset via Intl longOffset (e.g. "GMT+11") rather than the
 * fragile toLocaleString round-trip. Handles AEST/AEDT automatically.
 */
function melbourneOffsetMinutes(atMs) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: MEL_TZ, timeZoneName: "longOffset" });
  const part = fmt.formatToParts(new Date(atMs)).find((p) => p.type === "timeZoneName");
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ? part.value : "");
  if (!m) return 600; // AEST fallback
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}

function melbourneParts(atMs) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: MEL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(atMs))) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour, minute: +p.minute, weekday: p.weekday,
  };
}

/**
 * Daily period starts at 10:00 Melbourne. Before 10:00 we are still in
 * yesterday's session, so the period rolls back a day.
 */
function dayStartMs(atMs = Date.now()) {
  const p = melbourneParts(atMs);
  let y = p.year, mo = p.month, d = p.day;
  if (p.hour < SESSION_START_HOUR) {
    const prev = new Date(Date.UTC(y, mo - 1, d) - 86400000);
    y = prev.getUTCFullYear(); mo = prev.getUTCMonth() + 1; d = prev.getUTCDate();
  }
  const naive = Date.UTC(y, mo - 1, d, SESSION_START_HOUR, 0, 0);
  return naive - melbourneOffsetMinutes(atMs) * 60000;
}

/** Weekly period starts Monday 10:00 Melbourne. */
function weekStartMs(atMs = Date.now()) {
  const dayStart = dayStartMs(atMs);
  const p = melbourneParts(dayStart + 60000);
  const idx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday] ?? 0;
  return dayStart - idx * 86400000;
}

function dayPeriodId(atMs = Date.now()) {
  return new Date(dayStartMs(atMs)).toISOString().slice(0, 16);
}
function weekPeriodId(atMs = Date.now()) {
  return new Date(weekStartMs(atMs)).toISOString().slice(0, 16);
}

// ============================================================
// VALIDATION / HELPERS
// ============================================================

function validateOpen(b) {
  if (b.ticket === undefined || b.ticket === null || String(b.ticket).length === 0)
    return "ticket is required";
  if (b.account && !["personal", "ftmo"].includes(b.account)) return "account must be personal or ftmo";
  if (typeof b.symbol !== "string" || !b.symbol) return "symbol is required";
  if (!["buy", "sell"].includes(b.direction)) return "direction must be buy or sell";
  if (!isIso(b.entry_time)) return "entry_time must be ISO 8601";
  if (typeof b.entry_price !== "number" || b.entry_price <= 0) return "entry_price must be > 0";
  if (typeof b.lot_size !== "number" || b.lot_size <= 0) return "lot_size must be > 0";
  if (typeof b.original_sl !== "number") return "original_sl must be a number (0 if none)";
  if (b.risk_percent !== undefined && b.risk_percent !== null) {
    if (typeof b.risk_percent !== "number" || b.risk_percent < 0 || b.risk_percent > 5)
      return "risk_percent must be 0-5";
  }
  return null;
}

function validateDeal(b) {
  if (!b.ticket) return "ticket is required";
  if (!b.deal_id) return "deal_id is required";
  if (!isIso(b.deal_time)) return "deal_time must be ISO 8601";
  if (typeof b.deal_price !== "number" || b.deal_price <= 0) return "deal_price must be > 0";
  if (typeof b.deal_lots !== "number" || b.deal_lots <= 0) return "deal_lots must be > 0";
  if (typeof b.deal_pnl !== "number") return "deal_pnl must be a number";
  if (typeof b.remaining_lots !== "number" || b.remaining_lots < 0) return "remaining_lots must be >= 0";
  return null;
}

/**
 * Context schema matches the Suite's ACTUAL per-pair fields, verified
 * against MCJ_Trading_Suite.html. Do not "tidy" these value lists - they
 * are the exact option values the app stores in d.<field>.
 *
 *   d1struct / h4struct  : bullish | bearish | neutral        (STRUCT)
 *   d1choch  / h4choch   : 5 CHoCH values                     (CHOCH)
 *   m15dir               : 5 direction/BOS values             (M15)
 *   position             : 9 alignment-encoded values          (POSITION)
 *   grade                : A+ | A | B | C | F  (from SCORING_CONFIG boundaries)
 *   checklist_score      : 0-100 (sections 45+22+28+5 = 100)
 */
const STRUCT_VALS = ["bullish", "bearish", "neutral"];
const CHOCH_VALS = ["bull_no_choch", "bear_no_choch", "bull_break_above", "bear_break_below", "pending"];
const M15_VALS = ["bullish", "bullish_bos", "bearish", "bearish_bos", "neutral"];
const POSITION_VALS = [
  "long_d1_h4", "long_h4_only", "long_d1_only", "long_pending",
  "short_d1_h4", "short_h4_only", "short_d1_only", "short_pending", "no_position",
];
const GRADE_VALS = ["A+", "A", "B", "C", "F"];

function validateContext(b) {
  if (typeof b.symbol !== "string" || !b.symbol) return "symbol is required";
  if (!isIso(b.timestamp_gmt)) return "timestamp_gmt must be ISO 8601";

  // Structure fields: optional individually (you may not have scored every
  // timeframe), but rejected if present with an unrecognised value - a typo
  // must fail loudly rather than silently storing junk you'd later filter on.
  if (b.d1struct && !STRUCT_VALS.includes(b.d1struct)) return `d1struct must be one of ${STRUCT_VALS.join(", ")}`;
  if (b.h4struct && !STRUCT_VALS.includes(b.h4struct)) return `h4struct must be one of ${STRUCT_VALS.join(", ")}`;
  if (b.d1choch && !CHOCH_VALS.includes(b.d1choch)) return `d1choch must be one of ${CHOCH_VALS.join(", ")}`;
  if (b.h4choch && !CHOCH_VALS.includes(b.h4choch)) return `h4choch must be one of ${CHOCH_VALS.join(", ")}`;
  if (b.m15dir && !M15_VALS.includes(b.m15dir)) return `m15dir must be one of ${M15_VALS.join(", ")}`;
  if (b.position && !POSITION_VALS.includes(b.position)) return `position must be one of ${POSITION_VALS.join(", ")}`;
  if (b.grade && !GRADE_VALS.includes(b.grade)) return `grade must be one of ${GRADE_VALS.join(", ")}`;
  if (b.amber !== undefined && b.amber !== null && typeof b.amber !== "boolean") return "amber must be boolean";

  // Sections total 100, but penalties (P1-P7) sum to -68, so a weak setup with
  // penalties applied legitimately scores below zero. The old 0-100 bound
  // rejected those with a 422 and lost the whole context record.
  if (b.checklist_score !== undefined && b.checklist_score !== null) {
    if (typeof b.checklist_score !== "number" || b.checklist_score < -100 || b.checklist_score > 200)
      return "checklist_score must be between -100 and 200";
  }

  // Scorer sub-totals: {score, max, display}. Optional, but a present value
  // with a non-numeric score is a wiring fault worth failing loudly.
  for (const k of ["trend_str", "zone_sweep", "exec", "sl_room"]) {
    if (b[k] !== undefined && b[k] !== null) {
      if (typeof b[k] !== "object" || typeof b[k].score !== "number")
        return `${k} must be an object with a numeric score`;
    }
  }
  if (b.prep_done !== undefined && b.prep_done !== null && typeof b.prep_done !== "number")
    return "prep_done must be a number";
  if (b.rr !== undefined && b.rr !== null && typeof b.rr !== "object")
    return "rr must be an object";
  if (b.zone && typeof b.zone === "object") {
    for (const k of ["zds", "zfi", "zsa"]) {
      if (b.zone[k] !== undefined && b.zone[k] !== null && typeof b.zone[k] !== "number")
        return `zone.${k} must be a number`;
    }
  }
  return null;
}

/**
 * Derived from Position, which encodes D1/H4 alignment directly.
 * Mirrors the Suite's own sizing rule: A-grade (D1+H4) 0.5%, H4-only 0.25%.
 */
function alignmentOf(position) {
  if (!position || position === "no_position") return null;
  if (position === "long_d1_h4" || position === "short_d1_h4") return "d1_h4";
  if (position === "long_h4_only" || position === "short_h4_only") return "h4_only";
  if (position === "long_d1_only" || position === "short_d1_only") return "d1_only";
  return "pending";
}

function normalizeSymbol(s) {
  if (typeof s !== "string") return "";
  const dot = s.indexOf(".");
  return (dot > 0 ? s.slice(0, dot) : s).toUpperCase().trim();
}

function isIso(s) {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return false;
  return !isNaN(new Date(s).getTime());
}

async function parseJson(request) {
  try { return await request.json(); } catch { return null; }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const round2 = (n) => Math.round(n * 100) / 100;
const round5 = (n) => Math.round(n * 100000) / 100000;

function json(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ============================================================
// WIRE INTO EXISTING fx-proxy fetch handler
// ============================================================
// const MCJ_PATHS = ["/trade", "/trade/deal", "/heartbeat", "/context",
//                    "/alert", "/journal", "/risk", "/push/subscribe"];
// const url = new URL(request.url);
// if (MCJ_PATHS.includes(url.pathname)) {
//   return handleJournalRequest(request, env, url.pathname);
// }

// ============================================================
// ENTRY POINT
// ============================================================
//
// If fx-proxy already has its own `export default { fetch }`, do NOT paste
// this block - instead add the MCJ_PATHS check to the top of your existing
// fetch handler (see the commented example above) and delete this section.
//
// If you are pasting this file as a brand-new Worker, leave this as-is.

const MCJ_PATHS = [
  "/trade", "/trade/deal", "/heartbeat", "/context",
  "/alert", "/journal", "/risk", "/push/subscribe",
  "/context/backfill", "/admin/reset", "/executions",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (MCJ_PATHS.includes(url.pathname)) {
      return handleJournalRequest(request, env, url.pathname);
    }

    // Health check so you can confirm the Worker is alive in a browser.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "MCJ journal worker", paths: MCJ_PATHS }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
