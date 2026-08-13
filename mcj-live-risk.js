/**
 * mcj-live-risk.js  —  MCJ Trading Suite live risk integration
 *
 * Additive: no edits needed inside MCJ_Trading_Suite.html's 13,000 lines
 * beyond one <script> tag. This file patches the existing functions at
 * runtime rather than replacing them.
 *
 * WHAT IT DOES
 *   1. Feeds the yellow strip (Balance / Risk-per-trade / Rem DD / Week P&L)
 *      and the Risk Manager tab from live MT5 equity instead of manual entry.
 *   2. Auto-fills the Week Trade Tracker from real closed trades, while
 *      keeping your W/L/B buttons working as a manual override.
 *   3. Replaces the yellow strip's hint text with a rule warning whenever
 *      one is active (2 consecutive losses, 2 trades/day amber,
 *      3 trades/day red, daily/weekly drawdown cap).
 *   4. Posts pre-trade context to the Worker so trades journal with the
 *      D1/H4/CHoCH/M15/Position state that was live when you entered.
 *
 * LOAD ORDER: must come AFTER the Suite's own scripts, i.e. immediately
 * before </body>. It captures references to the app's functions on load.
 */

(function () {
  "use strict";

  // ─────────── CONFIG ───────────
  var WORKER = "https://fx-proxy.mwwakista.workers.dev";
  var API_KEY = "mcj-trading-secret-8271-kj";
  var POLL_MS = 180000;   // 3 min - KV quota friendly

  var LIVE = null;          // latest risk payload from the Worker
  var LIVE_OK = false;      // false => fall back to the app's manual figures
  var LAST_GOOD_BALANCE = null;

  function hdrs() {
    return { "Content-Type": "application/json", "X-MCJ-Key": API_KEY };
  }

  // ─────────── 1. LIVE FIGURES ───────────

  /*
   * The app's updateRisk() reads #ri-bal (a manual input) and writes the
   * strip pills. We keep calling it — the Risk Manager tab's own rows still
   * need it — then overwrite the live-sourced values afterwards.
   *
   * #ri-bal is also read by the R:R calculator and position sizing, so we
   * write the live balance INTO that input. If the heartbeat goes stale we
   * leave the last known value in place rather than zeroing it, which would
   * silently break position sizing mid-session.
   */
  /*
   * FIX: updateWeekly() recomputes Week P&L from the MANUAL day-input boxes and
   * writes it to #s-pnl, clobbering the live MT5 figure. It runs on its own
   * (oninput handlers, saveAll), so wrapping updateRisk alone isn't enough.
   * We wrap it too and repaint the live value afterwards.
   */
  var origUpdateWeekly = window.updateWeekly;
  window.updateWeekly = function () {
    if (typeof origUpdateWeekly === "function") origUpdateWeekly.apply(this, arguments);
    if (LIVE_OK) paintWeekPnl();
  };

  function paintWeekPnl() {
    if (!LIVE || !LIVE.display || LIVE.display.week_pnl === null) return;
    var v = LIVE.display.week_pnl;
    var el = document.getElementById("s-pnl");
    if (!el) return;
    el.textContent = (v >= 0 ? "+$" : "-$") + fmt0(Math.abs(v));
    el.style.color = v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : "var(--navy)";
  }

  var origUpdateRisk = window.updateRisk;
  window.updateRisk = function () {
    if (LIVE_OK && LIVE && LIVE.display && typeof LIVE.display.balance === "number") {
      var inp = document.getElementById("ri-bal");
      if (inp && Number(inp.value) !== LIVE.display.balance) {
        inp.value = LIVE.display.balance;
        LAST_GOOD_BALANCE = LIVE.display.balance;
      }
    }
    if (typeof origUpdateRisk === "function") origUpdateRisk.apply(this, arguments);
    if (LIVE_OK) paintLiveFigures();
  };

  function paintLiveFigures() {
    if (!LIVE || !LIVE.display) return;
    var d = LIVE.display;

    setPill("s-bal", d.balance !== null ? "$" + fmt0(d.balance) : null);
    setPill("tb-bal", d.balance !== null ? "$" + fmt0(d.balance) : null);
    setPill("s-risk", d.risk_per_trade !== null ? "$" + fmt0(d.risk_per_trade) : null);
    setPill("tb-risk", d.risk_per_trade !== null ? "$" + fmt0(d.risk_per_trade) + "/trade" : null);

    // Remaining drawdown: colour by how much headroom is left.
    if (d.remaining_dd !== null) {
      var el = document.getElementById("s-dd");
      if (el) {
        el.textContent = "$" + fmt0(d.remaining_dd);
        var pctLeft = d.balance ? d.remaining_dd / (d.balance * 0.03) : 1;
        el.style.color = pctLeft <= 0.01 ? "var(--red)"
                       : pctLeft <= 0.34 ? "#E08A2E"
                       : "var(--green)";
      }
      setPill("ri-rdd", "$" + fmt0(d.remaining_dd));
    }

    paintWeekPnl();
    markLive();
  }

  /* Small "LIVE" indicator so you can tell at a glance whether the figures
     are coming from MT5 or are stale manual values. */
  function markLive() {
    var strip = document.querySelector(".risk-strip > div:last-child");
    if (!strip) return;
    var tag = document.getElementById("mcj-live-tag");
    if (!tag) {
      tag = document.createElement("div");
      tag.id = "mcj-live-tag";
      tag.className = "rs-pill";
      tag.style.cssText = "font-size:10px;letter-spacing:.5px;";
      strip.appendChild(tag);
    }
    var stale = !LIVE || LIVE.heartbeat_stale;
    tag.innerHTML = stale
      ? '<span style="color:#E08A2E">● MANUAL</span>'
      : '<span style="color:var(--green)">● LIVE MT5</span>';
    tag.title = stale
      ? "No recent EA heartbeat — figures may be out of date. Check the VPS."
      : "Balance, risk and drawdown are coming from MT5.";
  }

  function setPill(id, text) {
    if (text === null) return;
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function fmt0(n) {
    return Math.round(n).toLocaleString();
  }

  // ─────────── 2. WEEK TRADE TRACKER ───────────

  /*
   * Live trades are merged into the app's own fx_tracker structure so the
   * existing render, summary and Sheets sync all keep working unchanged.
   *
   * Auto entries are tagged {src:'mt5'} and are replaced wholesale on each
   * poll. Manual entries have no src tag and are always preserved, so a
   * trade MT5 missed can still be added by hand and will never be wiped.
   */
  function mergeTrackerFromLive() {
    if (!LIVE || !LIVE.week) { dbg("merge skipped: no week data"); return; }
    if (typeof window.getTracker !== "function") { dbg("merge skipped: getTracker missing"); return; }

    var t;
    try { t = window.getTracker(); } catch (e) { dbg("getTracker threw: " + e.message); return; }
    if (!t || typeof t !== "object") t = {};
    if (!Array.isArray(t.days) || t.days.length !== 5) t.days = [[], [], [], [], []];

    for (var di = 0; di < 5; di++) {
      var manual = (t.days[di] || []).filter(function (e) {
        return !(e && typeof e === "object" && e.src === "mt5");
      });
      var auto = (LIVE.week.days[di] && LIVE.week.days[di].entries || []).map(function (e) {
        return { type: e.type, pct: e.pct, src: "mt5", symbol: e.symbol, r: e.r };
      });
      t.days[di] = auto.concat(manual);
    }

    var live = t.days.reduce(function (n, d) {
      return n + d.filter(function (e) { return e && e.src === "mt5"; }).length;
    }, 0);
    dbg("merged " + live + " MT5 trade(s) into tracker");

    try {
      window.saveTracker(t);
    } catch (e) { dbg("saveTracker threw: " + e.message); }

    // renderTrackerDays() calls updateTrackerSummary() internally, but call it
    // directly as a fallback in case the render is skipped (tab not visible).
    try {
      if (typeof window.renderTrackerDays === "function") window.renderTrackerDays();
      else if (typeof window.updateTrackerSummary === "function") window.updateTrackerSummary(t);
    } catch (e) { dbg("render threw: " + e.message); }
  }

  /* Manual diagnostic: run mcjDebugTracker() in the console. */
  window.mcjDebugTracker = function () {
    console.log("LIVE_OK:", LIVE_OK);
    console.log("week from Worker:", LIVE && LIVE.week ? LIVE.week.totals : null);
    console.log("days trades:", LIVE && LIVE.week ? LIVE.week.days.map(function (d) { return d.trades; }) : null);
    console.log("getTracker():", typeof window.getTracker === "function" ? window.getTracker() : "MISSING");
    console.log("renderTrackerDays:", typeof window.renderTrackerDays);
    console.log("saveTracker:", typeof window.saveTracker);
    mergeTrackerFromLive();
    console.log("after merge:", typeof window.getTracker === "function" ? window.getTracker() : null);
  };

  function dbg(msg) { console.log("MCJ tracker: " + msg); }

  /*
   * FIX for a live bug in the Suite: updateTrackerSummary() compares entries
   * with `e === 'win'`, but addTrade() stores objects {type,pct}. An object
   * never equals a string, so every trade fell through to the B/E counter and
   * W / L / Win% always read zero. This replacement reads e.type properly.
   */
  window.updateTrackerSummary = function (t) {
    var wins = 0, losses = 0, be = 0, netPct = 0;
    var riskPct = typeof window.getRiskPct === "function" ? window.getRiskPct() : 0.5;

    (t.days || []).forEach(function (day) {
      (day || []).forEach(function (e) {
        var type = (e && typeof e === "object") ? e.type : e;
        if (type === "win") wins++;
        else if (type === "loss") losses++;
        else be++;

        var pct = (e && typeof e === "object" && typeof e.pct === "number")
          ? e.pct
          : (type === "win" ? riskPct : type === "loss" ? -riskPct : 0);
        netPct += pct;
      });
    });

    var total = wins + losses + be;
    function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    set("ts-w", wins); set("ts-l", losses); set("ts-b", be); set("ts-t", total);
    set("ts-wr", total > 0 ? Math.round(wins / total * 100) + "%" : "—");

    netPct = Math.round(netPct * 100) / 100;
    var rEl = document.getElementById("ts-ret");
    if (rEl) {
      rEl.textContent = (netPct >= 0 ? "+" : "") + netPct.toFixed(2) + "%";
      rEl.style.color = netPct > 0 ? "var(--green)" : netPct < 0 ? "var(--red)" : "var(--text1)";
    }
  };

  // ─────────── 3. WARNING MESSAGE IN THE YELLOW STRIP ───────────

  var DEFAULT_HINT = null;

  /*
   * Priority order matters: the most restrictive breach wins, so a drawdown
   * cap is never hidden behind a softer trade-count notice.
   */
  function activeWarning(risk) {
    if (!risk) return null;
    var caps = LIVE_CAPS || { daily: -1, weekly: -3 };

    if (risk.weekly_pnl_percent !== null && risk.weekly_pnl_percent <= caps.weekly)
      return { level: "red", msg: "WEEKLY DRAWDOWN CAP HIT (" + risk.weekly_pnl_percent +
        "%) — stop trading for the week." };

    if (risk.daily_pnl_percent !== null && risk.daily_pnl_percent <= caps.daily)
      return { level: "red", msg: "DAILY DRAWDOWN CAP HIT (" + risk.daily_pnl_percent +
        "%) — stop trading for the session." };

    if (risk.trades_today >= 3)
      return { level: "red", msg: risk.trades_today +
        " TRADES TODAY — over your 2/day limit. No further entries." };

    if (risk.streak >= 3)
      return { level: "red", msg: risk.streak +
        " CONSECUTIVE LOSSES — stop and review before the next entry." };

    if (risk.streak >= 2)
      return { level: "amber", msg: risk.streak +
        " consecutive losses — reduce position size to 0.25% on the next entry." };

    if (risk.trades_today >= 2)
      return { level: "amber", msg: "2 trades today — daily allowance used. No more entries this session." };

    return null;
  }

  var LIVE_CAPS = null;

  function paintWarning(risk) {
    var hint = document.querySelector(".risk-strip .hint");
    if (!hint) return;
    if (DEFAULT_HINT === null) DEFAULT_HINT = hint.innerHTML;

    var w = activeWarning(risk);
    if (!w) {
      hint.innerHTML = DEFAULT_HINT;
      hint.style.cssText = "";
      return;
    }

    var isRed = w.level === "red";
    hint.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:700;" +
      "color:" + (isRed ? "#7F1D1D" : "#7A4B00") + ";" +
      "background:" + (isRed ? "#FDE8E8" : "#FFF4D6") + ";" +
      "border:1px solid " + (isRed ? "#E74C3C" : "#E0A32E") + ";" +
      "border-radius:6px;padding:6px 10px;";
    hint.innerHTML = '<span style="font-size:14px">' + (isRed ? "⛔" : "⚠") + "</span>" +
      '<span>' + escapeHtml(w.msg) + "</span>";
  }

  /* Alias used by the activity panel. */
  function esc(s) { return escapeHtml(s); }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ─────────── 4. CONTEXT POSTING ───────────

  /*
   * Reads the pair's live state straight out of the app's own getPair()
   * object, so field names and values always match what the Suite stores.
   * Symbol is de-slashed for the Worker ("GBP/USD" -> "GBPUSD"), which is
   * what the EA also sends after stripping Pepperstone's ".a" suffix.
   */
  window.mcjPostContext = function (pair) {
    if (typeof window.getPair !== "function") return Promise.resolve(false);
    var d = window.getPair(pair) || {};

    var score = null, grade = null, posSize = null, autoFail = null, amber = null;
    if (typeof window.calculateSetupScore === "function") {
      try {
        var res = window.calculateSetupScore(d.setup, d.zone);
        // hasAny guards against posting a grade for a pair you haven't scored:
        // an unscored setup returns grade 'F', which would look like a real
        // judgement in the journal rather than an absence of one.
        if (res && res.hasAny) {
          score = typeof res.total === "number" ? res.total : null;
          grade = res.grade || null;
          posSize = res.positionSize || null;
          autoFail = res.autoFail || null;
          amber = !!res.amber;
        }
      } catch (e) { /* scoring not available for this pair yet */ }
    }

    var body = {
      symbol: String(pair).replace(/\//g, "").toUpperCase(),
      timestamp_gmt: new Date().toISOString(),
      d1struct: d.d1struct || undefined,
      h4struct: d.h4struct || undefined,
      d1choch: d.d1choch || undefined,
      h4choch: d.h4choch || undefined,
      m15dir: d.m15dir || undefined,
      position: d.position || undefined,
      order_type: d.ot || undefined,     // verified: the Suite stores this as d.ot
      session: d.session_radio || undefined,   // the Suite has no `session` key
      zone: d.zone ? { zds: d.zone.zds, zfi: d.zone.zfi, zsa: d.zone.zsa } : undefined,
      checklist_score: score,
      grade: grade,
      position_size: posSize,
      auto_fail: autoFail,
      amber: amber,
    };

    return fetch(WORKER + "/context", {
      method: "POST", headers: hdrs(), body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (txt) {
          console.error("MCJ context rejected", r.status, txt);
          return false;
        });
        console.log("MCJ context posted for " + pair);
        return true;
      })
      .catch(function (e) { console.error("MCJ context failed", e); return false; });
  };

  // ─────────── AUTO CONTEXT ATTACHMENT ───────────

  /*
   * The missing link in the original design. Time-window matching between a
   * checklist entry and a trade is unreliable because you score the zone, then
   * wait for M15 confirmation - an unpredictable gap.
   *
   * Instead: when a trade appears with no context, read the CURRENT checklist
   * state for that pair and attach it to the ticket directly. Runs once per
   * ticket; the ticket is remembered so a later checklist edit can't silently
   * rewrite the conditions you actually entered on.
   */
  var CTX_DONE_KEY = "mcj_ctx_attached_v1";

  function ctxDone() {
    try { return JSON.parse(localStorage.getItem(CTX_DONE_KEY) || "[]"); } catch (e) { return []; }
  }
  function ctxMark(ticket) {
    var d = ctxDone();
    if (d.indexOf(ticket) === -1) { d.push(ticket); }
    try { localStorage.setItem(CTX_DONE_KEY, JSON.stringify(d.slice(-500))); } catch (e) {}
  }

  function pairLabelFor(symbol) {
    if (typeof window.allPairs === "function") {
      var m = window.allPairs().find(function (p) {
        return p.replace(/\//g, "").toUpperCase() === symbol.toUpperCase();
      });
      if (m) return m;
    }
    return symbol.length === 6 ? symbol.slice(0, 3) + "/" + symbol.slice(3) : symbol;
  }

  /**
   * Collects the checklist conditions for a pair, ready to attach to a ticket.
   *
   * Field notes:
   *  - session comes from `session_radio`; the Suite has never stored a plain
   *    `session` key, so the previous read was always undefined.
   *  - The five scorer sub-totals live in sectionScores keyed trend/zone/exec/sl
   *    (maxima 45/22/28/5) with penalties held separately.
   *  - R:R is in its own localStorage key, `fx_pair_<PAIR>_rr`, not on the pair
   *    object, so it needs a second read.
   *  - checklist_saved_at records WHEN the analysis was saved. Attachment reads
   *    current state, so a fill that lands while the Suite is closed can pick up
   *    a later day's analysis. Stamping the source date makes that visible in
   *    the record rather than silently assumed.
   */
  function buildContext(pair, ticket) {
    if (typeof window.getPair !== "function") return null;
    var d = window.getPair(pair) || {};

    var score = null, grade = null, posSize = null, autoFail = null, amber = null;
    var secTrend = null, secZone = null, secExec = null, secSl = null, penTotal = null, maxScore = null;
    if (typeof window.calculateSetupScore === "function") {
      try {
        var res = window.calculateSetupScore(d.setup, d.zone);
        if (res && res.hasAny) {
          score    = typeof res.total === "number" ? res.total : null;
          grade    = res.grade || null;
          posSize  = res.positionSize || null;
          autoFail = res.autoFail || null;
          amber    = !!res.amber;
          maxScore = typeof res.maxScore === "number" ? res.maxScore : null;
          penTotal = typeof res.penaltyTotal === "number" ? res.penaltyTotal : null;
          var ss = res.sectionScores || {};
          function sec(k) {
            var s = ss[k];
            if (!s || typeof s.score !== "number") return null;
            return { score: s.score, max: s.max, display: s.score + "/" + s.max };
          }
          secTrend = sec("trend");   /* Trend & Structure  /45 */
          secZone  = sec("zone");    /* Zone & Sweep       /22 */
          secExec  = sec("exec");    /* Execution          /28 */
          secSl    = sec("sl");      /* Stop Loss          /5  */
        }
      } catch (e) {}
    }

    /* Prep is an array of 11 booleans; send the count and the raw flags so the
       table can show "11/11" without re-deriving. */
    var prepArr = Array.isArray(d.prep) ? d.prep : null;
    var prepDone = prepArr ? prepArr.filter(Boolean).length : null;

    /* R:R lives in a separate key. */
    var rr = null;
    try {
      var rraw = localStorage.getItem("fx_pair_" + pair + "_rr");
      if (rraw) {
        var r = JSON.parse(rraw);
        if (r && (r.entry || r.stop || r.target)) {
          rr = { entry: r.entry ?? null, stop: r.stop ?? null, target: r.target ?? null };
          var e0 = parseFloat(r.entry), s0 = parseFloat(r.stop), t0 = parseFloat(r.target);
          if (isFinite(e0) && isFinite(s0) && isFinite(t0) && Math.abs(e0 - s0) > 0) {
            rr.ratio = Math.round(Math.abs(t0 - e0) / Math.abs(e0 - s0) * 100) / 100;
            rr.display = rr.ratio.toFixed(2) + "R";
          }
        }
      }
    } catch (e) {}

    // Nothing scored and no structure set => no real context to attach.
    var hasAny = d.d1struct || d.h4struct || d.position || score !== null;
    if (!hasAny) return null;

    return {
      ticket: String(ticket),
      symbol: String(pair).replace(/\//g, "").toUpperCase(),
      pair: pair,
      timestamp_gmt: new Date().toISOString(),

      /* structure */
      d1struct: d.d1struct || undefined,
      h4struct: d.h4struct || undefined,
      d1choch: d.d1choch || undefined,
      h4choch: d.h4choch || undefined,
      m15dir: d.m15dir || undefined,
      position: d.position || undefined,
      position_label: (typeof window.posLabel === "function" && d.position)
        ? window.posLabel(d.position) : undefined,
      order_type: d.ot || undefined,
      session: d.session_radio || undefined,

      /* prep */
      prep_done: prepDone,
      prep_max: prepArr ? prepArr.length : undefined,
      prep_display: prepArr ? (prepDone + "/" + prepArr.length) : undefined,
      prep_flags: prepArr || undefined,

      /* zone */
      zone: d.zone ? { zds: d.zone.zds, zfi: d.zone.zfi, zsa: d.zone.zsa } : undefined,
      zone_level: (d.zone && d.zone.level) || undefined,

      /* scorer */
      checklist_score: score,
      checklist_max: maxScore,
      grade: grade,
      position_size: posSize,
      auto_fail: autoFail,
      amber: amber,
      trend_str: secTrend || undefined,
      zone_sweep: secZone || undefined,
      exec: secExec || undefined,
      sl_room: secSl || undefined,
      penalty_total: penTotal,

      /* R:R */
      rr: rr || undefined,

      /* provenance */
      checklist_saved_at: d.setupSavedAt || undefined,
      attached_from: "current_checklist"
    };
  }

  function attachMissingContext(trades) {
    var done = ctxDone();
    trades.forEach(function (t) {
      if (!t.context_missing) return;
      if (done.indexOf(t.ticket) > -1) return;

      var pair = pairLabelFor(t.symbol);
      var body = buildContext(pair, t.ticket);
      if (!body) {
        console.log("MCJ context: nothing scored for " + pair + ", skipping ticket " + t.ticket);
        return;
      }

      fetch(WORKER + "/context/backfill", {
        method: "POST", headers: hdrs(), body: JSON.stringify(body),
      }).then(function (r) {
        if (r.ok) {
          ctxMark(t.ticket);
          console.log("MCJ context: attached " + pair + " conditions to ticket " + t.ticket);
        } else {
          return r.text().then(function (x) { console.warn("MCJ context rejected:", r.status, x); });
        }
      }).catch(function (e) { console.warn("MCJ context failed:", e.message); });
    });
  }

  /* Manual re-attach, e.g. after correcting the checklist. */
  window.mcjAttachContext = function (ticket) {
    fetch(WORKER + "/journal?limit=50", { headers: hdrs() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var t = d.trades.find(function (x) { return x.ticket === String(ticket); });
        if (!t) return console.warn("No trade with ticket " + ticket);
        var body = buildContext(pairLabelFor(t.symbol), t.ticket);
        if (!body) return console.warn("Nothing scored for " + t.symbol);
        return fetch(WORKER + "/context/backfill", {
          method: "POST", headers: hdrs(), body: JSON.stringify(body),
        }).then(function (r) { console.log(r.ok ? "Attached." : "Failed: " + r.status); });
      });
  };

  // ─────────── ACTIVITY PANEL (alerts + trades) ───────────

  var TRADES = [];
  var PANEL_OPEN = false;

  function ensureButton() {
    var strip = document.querySelector(".risk-strip > div:last-child");
    if (!strip) return;
    if (document.getElementById("mcj-activity-btn")) return;

    var b = document.createElement("div");
    b.id = "mcj-activity-btn";
    b.className = "rs-pill";
    b.style.cssText = "cursor:pointer;user-select:none;";
    b.onclick = function () { PANEL_OPEN = !PANEL_OPEN; renderPanel(); };
    strip.appendChild(b);
    updateButton();
  }

  function updateButton() {
    var b = document.getElementById("mcj-activity-btn");
    if (!b) return;
    var alerts = (LIVE && LIVE._alerts) || [];
    var n = alerts.length;
    b.innerHTML = "Activity <strong style=\"color:" + (n ? "var(--red)" : "var(--navy)") +
      "\">" + (n ? n : "0") + "</strong>";
  }

  function renderPanel() {
    var el = document.getElementById("mcj-activity-panel");
    if (!PANEL_OPEN) { if (el) el.remove(); return; }

    if (!el) {
      el = document.createElement("div");
      el.id = "mcj-activity-panel";
      el.style.cssText = "position:fixed;right:14px;top:70px;width:min(460px,92vw);max-height:70vh;" +
        "overflow:auto;z-index:9998;background:#fff;border:1px solid #D8DEE9;border-radius:10px;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.18);padding:14px;font-family:system-ui,sans-serif;font-size:12.5px;";
      document.body.appendChild(el);
    }

    var alerts = (LIVE && LIVE._alerts) || [];
    var h = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<strong style="font-size:13px">MCJ Activity</strong>' +
      '<span style="margin-left:auto;display:flex;align-items:center;gap:10px">' +
      '<span style="cursor:pointer;font-size:11px;color:#475569;text-decoration:underline" ' +
      'onclick="mcjPopAlerts()" title="Open alerts in a separate window for side-by-side MT5 comparison">\u29c9 Pop out</span>' +
      '<span style="cursor:pointer;opacity:.5;font-size:16px" onclick="mcjCloseActivity()">&times;</span></span></div>';

    h += '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.55;margin-bottom:5px">Alerts</div>';
    if (!alerts.length) {
      h += '<div style="opacity:.5;padding:4px 0 10px">No alerts. Rules are being followed.</div>';
    } else {
      alerts.slice(0, 15).forEach(function (a) {
        var col = a.severity === "critical" ? "#B91C1C" : a.severity === "warning" ? "#B45309" : "#475569";
        h += '<div style="padding:6px 8px;margin-bottom:4px;border-left:3px solid ' + col +
          ';background:#F8FAFC;border-radius:4px">' +
          '<div style="color:' + col + ';font-weight:600">' + esc(a.message) + '</div>' +
          '<div style="opacity:.5;font-size:10.5px">' + fmtTime(a.triggered_at) + '</div></div>';
      });
    }

    h += '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.55;margin:12px 0 5px">Trades</div>';
    if (!TRADES.length) {
      h += '<div style="opacity:.5">No trades recorded yet.</div>';
    } else {
      h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
        '<tr style="text-align:left;opacity:.55"><th>Pair</th><th>Dir</th><th>R</th><th>P&L</th><th style="width:45%">Conditions at entry</th></tr>';
      TRADES.slice(0, 25).forEach(function (t) {
        var r = t.r_multiple;
        var rCol = r === null || r === undefined ? "#475569" : r > 0.05 ? "#166534" : r < -0.05 ? "#B91C1C" : "#B45309";
        var ctx = t.context;
        var setup;
        if (!ctx) {
          setup = '<span style="opacity:.45">not scored</span>';
        } else {
          // Show the actual conditions, not just a letter - the whole point of
          // journaling is being able to see WHY the trade was taken.
          var bits = [];
          if (ctx.grade) bits.push('<b>' + esc(ctx.grade) + '</b>' +
            (typeof ctx.checklist_score === "number" ? " (" + ctx.checklist_score + ")" : ""));
          if (ctx.d1struct || ctx.h4struct)
            bits.push("D1 " + esc(ctx.d1struct || "?") + " / H4 " + esc(ctx.h4struct || "?"));
          if (ctx.h4choch) bits.push("H4 " + esc(shortChoch(ctx.h4choch)));
          if (ctx.m15dir) bits.push("M15 " + esc(shortM15(ctx.m15dir)));
          if (ctx.position) bits.push(esc(shortPos(ctx.position)));
          if (ctx.zone && typeof ctx.zone.zds === "number")
            bits.push("zone " + (ctx.zone.zds + (ctx.zone.zfi || 0) + (ctx.zone.zsa || 0)));
          setup = '<div style="line-height:1.45">' + bits.join('<br><span style="opacity:.6">') +
                  (bits.length > 1 ? '</span>' : '') + '</div>';
        }
        h += '<tr style="border-top:1px solid #EEF1F5">' +
          '<td style="padding:4px 0">' + esc(t.symbol) + (t.closed ? "" : ' <span style="color:#B45309">open</span>') + '</td>' +
          '<td>' + esc(t.direction) + '</td>' +
          '<td style="color:' + rCol + ';font-weight:600">' + (r === null || r === undefined ? "—" : r.toFixed(2) + "R") + '</td>' +
          '<td>' + (t.total_pnl === null || t.total_pnl === undefined ? "—" : (t.total_pnl >= 0 ? "+" : "") + t.total_pnl.toFixed(2)) + '</td>' +
          '<td>' + setup + '</td></tr>';
      });
      h += "</table>";
    }

    el.innerHTML = h;
  }

  window.mcjCloseActivity = function () { PANEL_OPEN = false; renderPanel(); };

  /* The pop-out alerts window deletes alerts server-side directly; this
     listener just keeps the Activity panel's cached copy in sync so a
     deletion shows up here immediately instead of after up to 3 minutes. */
  (function () {
    var ch;
    try { ch = new BroadcastChannel("mcj-alerts-sync"); } catch (e) { return; }
    ch.onmessage = function (ev) {
      if (!ev.data || ev.data.type !== "alerts-deleted" || !LIVE) return;
      var gone = {};
      ev.data.ids.forEach(function (id) { gone[id] = true; });
      LIVE._alerts = (LIVE._alerts || []).filter(function (a) { return !gone[a.id]; });
      updateButton();
      if (PANEL_OPEN) renderPanel();
    };
  })();

  /* Opens the standalone alerts page as its own OS-level window (not a tab),
     sized to sit next to an MT5 terminal. Reuses the same named window on
     repeat clicks instead of stacking duplicates. */
  window.mcjPopAlerts = function () {
    var url = new URL("mcj-alerts.html", window.location.href).href;
    var w = 440, h = 780;
    var left = window.screen.availWidth - w - 20;
    var top = 40;
    window.open(url, "mcjAlertsWindow",
      "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top +
      ",resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no");
  };

  function shortChoch(c) {
    return { bull_no_choch: "no CHoCH", bear_no_choch: "no CHoCH",
             bull_break_above: "break above", bear_break_below: "break below",
             pending: "pending" }[c] || c;
  }

  function shortM15(m) {
    return { bullish: "bullish", bullish_bos: "bullish BOS",
             bearish: "bearish", bearish_bos: "bearish BOS",
             neutral: "neutral" }[m] || m;
  }

  function shortPos(p) {
    return { long_d1_h4: "D1+H4 long", short_d1_h4: "D1+H4 short", long_h4_only: "H4 long",
             short_h4_only: "H4 short", long_d1_only: "D1 long", short_d1_only: "D1 short",
             long_pending: "pending long", short_pending: "pending short", no_position: "none" }[p] || p;
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney",
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return iso; }
  }

  // ─────────── POLLING ───────────

  function poll() {
    fetch(WORKER + "/risk", { headers: hdrs() })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (payload) {
        LIVE = payload.risk;
        LIVE_CAPS = payload.caps;
        LIVE_OK = !!(LIVE && LIVE.display && typeof LIVE.display.balance === "number");

        if (LIVE) LIVE._alerts = payload.alerts || [];

        if (LIVE_OK) {
          window.updateRisk();
          mergeTrackerFromLive();
        }
        paintWarning(LIVE);
        markLive();
        ensureButton();
        updateButton();
        if (PANEL_OPEN) renderPanel();
      })
      .catch(function (e) {
        console.warn("MCJ live risk unavailable:", e.message);
        LIVE_OK = false;
        markLive();
      });
  }

  function pollJournal() {
    fetch(WORKER + "/journal?limit=50", { headers: hdrs() })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        TRADES = (d.trades || []);
        attachMissingContext(TRADES);
        if (PANEL_OPEN) renderPanel();
      })
      .catch(function (e) { console.warn("MCJ journal poll:", e.message); });
  }

  function boot() {
    poll();
    pollJournal();
    setInterval(poll, POLL_MS);
    // Journal changes far less often than risk, so poll it separately/slower.
    setInterval(pollJournal, 300000);
    console.log("MCJ live risk module active");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();


/* ══════════════════════════════════════════════════════════════════════
   MCJ EXECUTIONS TAB  —  step 5 of the Executions build
   ══════════════════════════════════════════════════════════════════════

   Adds a fourth top-level tab ("Executions") to the right of Journal, and
   renders the trade log returned by the Worker's GET /executions endpoint.

   ADDITIVE, like the rest of this file: it injects its own button, its own
   panel and its own styles at runtime, and wraps suiteSwitch() rather than
   editing it. Nothing inside MCJ_Trading_Suite.html needs to change.

   FILTER PRESETS (per handover step 5)
     Last week / This week ..... Monday-Saturday, Melbourne
     Current month / Last month  calendar months, Melbourne
     Last 3 months ............. 1st of the month two months back -> today
     Custom .................... two date pickers
     Default ................... Current month

   All date maths is done on MELBOURNE calendar dates and handed to the
   Worker as YYYY-MM-DD; the Worker does the GMT+3 -> Melbourne conversion
   on entry_time before comparing, so a 22:30Z fill lands on the right day.
────────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var WORKER = "https://fx-proxy.mwwakista.workers.dev";
  var API_KEY = "mcj-trading-secret-8271-kj";
  var MEL = "Australia/Melbourne";

  var STATE = { preset: "month", from: null, to: null, trades: [], loading: false, err: null, open: {} };

  function hdrs() { return { "Content-Type": "application/json", "X-MCJ-Key": API_KEY }; }

  // ─────────── DATE HELPERS (Melbourne calendar) ───────────

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtD(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function toDate(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

  /* "Today" must be the Melbourne date even if the browser clock is elsewhere
     (VPS, travel, or a machine left on UTC), so derive it via Intl rather than
     trusting the local timezone. */
  function melToday() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: MEL, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
    } catch (e) {
      var n = new Date();
      return fmtD(n);
    }
  }

  /* Week runs Monday-Saturday. Sunday belongs to the week that just ended,
     which matches how the Week Trade Tracker is laid out (5 trading days
     plus Saturday), not the ISO week. */
  function mondayOf(d) {
    var dow = d.getDay();               // 0 Sun, 1 Mon ... 6 Sat
    var back = dow === 0 ? 6 : dow - 1; // Sunday -> back to the Monday just gone
    return addDays(d, -back);
  }

  function rangeFor(preset) {
    var today = toDate(melToday());
    var mon, first;

    if (preset === "thisweek") {
      mon = mondayOf(today);
      return { from: fmtD(mon), to: fmtD(addDays(mon, 5)) };
    }
    if (preset === "lastweek") {
      mon = addDays(mondayOf(today), -7);
      return { from: fmtD(mon), to: fmtD(addDays(mon, 5)) };
    }
    if (preset === "month") {
      first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: fmtD(first), to: fmtD(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
    }
    if (preset === "lastmonth") {
      first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { from: fmtD(first), to: fmtD(new Date(today.getFullYear(), today.getMonth(), 0)) };
    }
    if (preset === "3months") {
      first = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      return { from: fmtD(first), to: fmtD(today) };
    }
    // custom: keep whatever is already in the pickers
    return { from: STATE.from, to: STATE.to };
  }

  function melStamp(iso) {
    try {
      return new Date(iso).toLocaleString("en-AU", {
        timeZone: MEL, day: "2-digit", month: "short",
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
    } catch (e) { return iso || "—"; }
  }

  function melDateOnly(iso) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: MEL, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(iso));
    } catch (e) { return ""; }
  }

  // ─────────── SMALL UTILITIES ───────────

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function num(v) { return typeof v === "number" && isFinite(v); }
  function money(v) { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

  /* Scorer sub-totals arrive as {score,max,display}. Prefer the Suite's own
     display string when present so the tab never disagrees with the checklist;
     fall back to score/max only if display is missing. */
  function subScore(o) {
    if (!o || typeof o !== "object") return "—";
    if (o.display) return String(o.display);
    if (num(o.score)) return o.score + (num(o.max) ? "/" + o.max : "");
    return "—";
  }

  function sessionLabel(s) {
    return { A: "Asian", L: "London", NY: "New York", N: "New York" }[s] || (s || "—");
  }

  function posLabel(p) {
    return {
      long_d1_h4: "D1+H4 long", short_d1_h4: "D1+H4 short",
      long_h4_only: "H4 long", short_h4_only: "H4 short",
      long_d1_only: "D1 long", short_d1_only: "D1 short",
      long_pending: "pending long", short_pending: "pending short",
      no_position: "none",
    }[p] || (p || "—");
  }

  // ─────────── STYLES ───────────

  function injectStyles() {
    if (document.getElementById("mcj-exec-css")) return;
    var css = document.createElement("style");
    css.id = "mcj-exec-css";
    css.textContent = [
      "#exec-app{display:none;font-family:var(--fb,system-ui,sans-serif);background:var(--bg,#f5f3ef);",
      "  color:var(--text,#0f0e0d);min-height:calc(100vh - 38px);font-size:15px;line-height:1.5}",
      "#exec-app.on{display:block}",
      "#exec-app *{box-sizing:border-box}",
      "#exec-app .xw{max-width:1400px;margin:0 auto;padding:18px 16px}",
      "#exec-app .xhdr{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px}",
      "#exec-app .xtitle{font-family:var(--fm,monospace);font-size:19px;font-weight:700}",
      "#exec-app .xsub{font-size:12.5px;color:var(--text3,#7a7872);font-family:var(--fm,monospace)}",
      "#exec-app .xbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:16px;",
      "  padding:12px 15px;background:var(--surface,#fff);border:2px solid var(--border,#ccc9c0);border-radius:var(--r,8px)}",
      "#exec-app .xlbl{font-size:11.5px;font-weight:700;color:var(--text3,#7a7872);text-transform:uppercase;letter-spacing:.5px}",
      "#exec-app .xp{padding:5px 13px;border-radius:20px;border:1.5px solid var(--border,#ccc9c0);",
      "  background:var(--surface2,#edeae4);cursor:pointer;font-size:12.5px;font-weight:500;",
      "  color:var(--text2,#3d3b38);font-family:inherit;transition:all .12s}",
      "#exec-app .xp:hover{border-color:var(--border2,#a8a49a);color:var(--text,#0f0e0d)}",
      "#exec-app .xp.on{background:var(--text,#0f0e0d);border-color:var(--text,#0f0e0d);color:var(--surface,#fff)}",
      "#exec-app .xdt{padding:5px 9px;border:2px solid var(--border,#ccc9c0);border-radius:var(--r,8px);",
      "  font-size:12.5px;font-family:var(--fm,monospace);background:var(--surface,#fff);color:var(--text,#0f0e0d)}",
      "#exec-app .xbtn{padding:6px 15px;border-radius:var(--r,8px);border:2px solid var(--border,#ccc9c0);",
      "  background:var(--surface,#fff);cursor:pointer;font-size:12.5px;font-weight:600;font-family:inherit}",
      "#exec-app .xbtn:hover{background:var(--surface2,#edeae4)}",
      "#exec-app .xbtn.pri{background:var(--accent,#1a6b48);border-color:var(--accent,#1a6b48);color:#fff}",
      "#exec-app .xrange{margin-left:auto;font-size:12px;font-family:var(--fm,monospace);color:var(--text3,#7a7872)}",
      "#exec-app .xcards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:16px}",
      "#exec-app .xc{background:var(--surface,#fff);border:2px solid var(--border,#ccc9c0);",
      "  border-radius:var(--r,8px);padding:12px 14px}",
      "#exec-app .xcl{font-size:12px;color:var(--text2,#3d3b38);margin-bottom:3px}",
      "#exec-app .xcv{font-size:23px;font-weight:700;font-family:var(--fm,monospace)}",
      "#exec-app .xcs{font-size:11.5px;color:var(--text3,#7a7872);margin-top:2px}",
      "#exec-app .xtwrap{overflow-x:auto;border:2px solid var(--border2,#a8a49a);border-radius:var(--rl,12px);",
      "  background:var(--surface,#fff)}",
      "#exec-app table.xt{border-collapse:collapse;width:100%;min-width:1080px}",
      "#exec-app .xt thead th{background:var(--surface2,#edeae4);padding:8px 9px;font-size:11px;font-weight:700;",
      "  color:var(--text3,#7a7872);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;",
      "  text-align:left;border-bottom:2px solid var(--border2,#a8a49a)}",
      "#exec-app .xt td{padding:8px 9px;border-bottom:1px solid var(--border,#ccc9c0);font-size:13px;white-space:nowrap}",
      "#exec-app .xt tr.xrow{cursor:pointer}",
      "#exec-app .xt tr.xrow:hover td{background:#faf9f6}",
      "#exec-app .xt .mono{font-family:var(--fm,monospace)}",
      "#exec-app .xpill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11.5px;",
      "  font-weight:700;font-family:var(--fm,monospace);border:1.5px solid}",
      "#exec-app .g-A{background:#dcfce7;color:#166534;border-color:#86efac}",
      "#exec-app .g-B{background:#dbeafe;color:#1e3a8a;border-color:#93c5fd}",
      "#exec-app .g-C{background:#fef3c7;color:#92400e;border-color:#fcd34d}",
      "#exec-app .g-F{background:#fee2e2;color:#991b1b;border-color:#fca5a5}",
      "#exec-app .g-none{background:var(--surface2,#edeae4);color:var(--text3,#7a7872);border-color:var(--border,#ccc9c0)}",
      "#exec-app .dir-long{color:#166534;font-weight:700}",
      "#exec-app .dir-short{color:#991b1b;font-weight:700}",
      "#exec-app .pos{color:#166534;font-weight:700}",
      "#exec-app .neg{color:#991b1b;font-weight:700}",
      "#exec-app .flat{color:#92400e;font-weight:700}",
      "#exec-app .xopen{font-size:11px;padding:1px 7px;border-radius:20px;background:#fef3c7;",
      "  color:#92400e;border:1.5px solid #fcd34d;font-weight:700}",
      "#exec-app .xflag{font-size:11px;padding:1px 7px;border-radius:20px;font-weight:700;margin-left:4px}",
      "#exec-app .xflag.af{background:#fee2e2;color:#991b1b}",
      "#exec-app .xflag.am{background:#fef3c7;color:#92400e}",
      "#exec-app tr.xdet td{background:#faf9f6;padding:0;border-bottom:2px solid var(--border,#ccc9c0)}",
      "#exec-app .xdbox{padding:14px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}",
      "#exec-app .xdsec h4{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;",
      "  color:var(--text3,#7a7872);margin:0 0 6px;font-weight:700}",
      "#exec-app .xdr{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:2px 0}",
      "#exec-app .xdr span:first-child{color:var(--text2,#3d3b38)}",
      "#exec-app .xdr span:last-child{font-family:var(--fm,monospace);font-weight:600;text-align:right}",
      "#exec-app .xempty{padding:40px 20px;text-align:center;color:var(--text3,#7a7872);font-size:14px}",
      "#exec-app .xerr{padding:14px 16px;background:#fee2e2;border:2px solid #fca5a5;color:#991b1b;",
      "  border-radius:var(--r,8px);font-size:13.5px;margin-bottom:14px}",
      "@media(max-width:900px){#exec-app .xcards{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    ].join("");
    document.head.appendChild(css);
  }

  // ─────────── TAB WIRING ───────────

  function injectTab() {
    var sw = document.getElementById("suite-switch");
    if (!sw || document.getElementById("ss-exec")) return;

    var btn = document.createElement("button");
    btn.id = "ss-exec";
    btn.textContent = "Executions";
    btn.onclick = function () { suiteSwitch("exec"); };

    // Sit immediately to the right of Journal, before the spacer.
    var journal = document.getElementById("ss-journal");
    if (journal && journal.nextSibling) sw.insertBefore(btn, journal.nextSibling);
    else sw.appendChild(btn);

    var panel = document.getElementById("exec-app");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "exec-app";
      panel.innerHTML = '<div class="xw">' +
        '<div class="xhdr"><div class="xtitle">Executions</div>' +
        '<div class="xsub" id="x-sub">trade log \u00b7 Melbourne dates</div></div>' +
        '<div id="x-bar"></div><div id="x-err"></div>' +
        '<div id="x-cards"></div><div id="x-body"></div></div>';
      // Sits alongside the other top-level panels, after journal-app.
      var jApp = document.getElementById("journal-app");
      if (jApp && jApp.parentNode) jApp.parentNode.insertBefore(panel, jApp.nextSibling);
      else document.body.appendChild(panel);
    }

    /* Wrap rather than replace: the original handles fx/mo/journal and their
       lazy re-renders. Calling it with 'exec' correctly turns all three off,
       then we switch ours on. */
    var orig = window.suiteSwitch;
    window.suiteSwitch = function (which) {
      if (typeof orig === "function") {
        try { orig.apply(this, arguments); } catch (e) { console.warn("suiteSwitch:", e); }
      }
      var app = document.getElementById("exec-app");
      var b = document.getElementById("ss-exec");
      if (app) app.classList.toggle("on", which === "exec");
      if (b) b.classList.toggle("on", which === "exec");
      if (which === "exec") load();
    };
  }

  // ─────────── FILTER BAR ───────────

  var PRESETS = [
    ["lastweek", "Last week"], ["thisweek", "This week"],
    ["month", "Current month"], ["lastmonth", "Last month"],
    ["3months", "Last 3 months"], ["custom", "Custom"],
  ];

  function renderBar() {
    var el = document.getElementById("x-bar");
    if (!el) return;
    var h = '<div class="xbar"><span class="xlbl">Period</span>';
    PRESETS.forEach(function (p) {
      h += '<button class="xp' + (STATE.preset === p[0] ? " on" : "") +
        '" onclick="mcjExecPreset(\'' + p[0] + '\')">' + esc(p[1]) + "</button>";
    });
    if (STATE.preset === "custom") {
      h += '<input type="date" class="xdt" id="x-from" value="' + esc(STATE.from || "") + '">' +
        '<span style="color:var(--text3)">to</span>' +
        '<input type="date" class="xdt" id="x-to" value="' + esc(STATE.to || "") + '">' +
        '<button class="xbtn pri" onclick="mcjExecApplyCustom()">Apply</button>';
    }
    h += '<button class="xbtn" onclick="mcjExecReload()" title="Re-fetch from the Worker">\u21bb Refresh</button>';
    h += '<button class="xbtn" onclick="mcjExecCsv()" title="Download the visible rows as CSV">\u2193 CSV</button>';
    h += '<span class="xrange" id="x-range"></span></div>';
    el.innerHTML = h;
    paintRange();
  }

  function paintRange() {
    var el = document.getElementById("x-range");
    if (!el) return;
    el.textContent = STATE.loading ? "loading\u2026"
      : (STATE.from && STATE.to ? STATE.from + "  \u2192  " + STATE.to : "no range set");
  }

  window.mcjExecPreset = function (p) {
    STATE.preset = p;
    if (p !== "custom") {
      var r = rangeFor(p);
      STATE.from = r.from; STATE.to = r.to;
      renderBar(); load();
    } else {
      renderBar();
    }
  };

  window.mcjExecApplyCustom = function () {
    var f = document.getElementById("x-from"), t = document.getElementById("x-to");
    if (!f || !t || !f.value || !t.value) { alert("Pick both a from and a to date."); return; }
    if (f.value > t.value) { alert("The from date is after the to date."); return; }
    STATE.from = f.value; STATE.to = t.value;
    load();
  };

  window.mcjExecReload = function () { load(); };

  window.mcjExecToggle = function (ticket) {
    STATE.open[ticket] = !STATE.open[ticket];
    renderBody();
  };

  // ─────────── FETCH ───────────

  function load() {
    if (!STATE.from || !STATE.to) {
      var r = rangeFor(STATE.preset);
      STATE.from = r.from; STATE.to = r.to;
    }
    STATE.loading = true; STATE.err = null;
    renderBar(); renderBody();

    var url = WORKER + "/executions?from=" + encodeURIComponent(STATE.from) +
      "&to=" + encodeURIComponent(STATE.to);

    fetch(url, { headers: hdrs() })
      .then(function (r) {
        if (r.status === 401) throw new Error("Unauthorized \u2014 the API key in this file does not match the Worker secret.");
        if (r.status === 404) throw new Error("404 \u2014 /executions is not routed. Check MCJ_PATHS in the Worker includes \"/executions\".");
        if (!r.ok) return r.json().then(function (j) {
          throw new Error("HTTP " + r.status + (j && j.error ? " \u2014 " + j.error : ""));
        }, function () { throw new Error("HTTP " + r.status); });
        return r.json();
      })
      .then(function (d) {
        STATE.trades = Array.isArray(d.trades) ? d.trades : [];
        STATE.scanned = d.scanned;
        STATE.loading = false;
        renderBar(); renderCards(); renderBody();
      })
      .catch(function (e) {
        STATE.loading = false; STATE.err = e.message; STATE.trades = [];
        renderBar(); renderCards(); renderBody();
      });
  }

  // ─────────── SUMMARY CARDS ───────────

  function renderCards() {
    var el = document.getElementById("x-cards");
    if (!el) return;
    var t = STATE.trades;
    if (!t.length) { el.innerHTML = ""; return; }

    var closed = t.filter(function (x) { return x.closed; });
    var wins = 0, losses = 0, be = 0, pnl = 0, rSum = 0, rN = 0;
    closed.forEach(function (x) {
      if (num(x.total_pnl)) pnl += x.total_pnl;
      if (num(x.r_multiple)) {
        rSum += x.r_multiple; rN++;
        if (x.r_multiple > 0.05) wins++;
        else if (x.r_multiple < -0.05) losses++;
        else be++;
      }
    });
    var wr = (wins + losses) ? Math.round((wins / (wins + losses)) * 100) : null;
    var avgR = rN ? rSum / rN : null;
    var pnlCls = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "flat";

    el.innerHTML = '<div class="xcards">' +
      card("Trades", t.length, closed.length + " closed \u00b7 " + (t.length - closed.length) + " open") +
      card("Net P&amp;L", '<span class="' + pnlCls + '">' + money(pnl) + "</span>", "closed trades only") +
      card("Total R", '<span class="' + (rSum > 0 ? "pos" : rSum < 0 ? "neg" : "flat") + '">' +
        (rSum >= 0 ? "+" : "") + rSum.toFixed(2) + "R</span>", rN + " scored") +
      card("Avg R", avgR === null ? "\u2014" : (avgR >= 0 ? "+" : "") + avgR.toFixed(2) + "R",
        wins + "W / " + losses + "L / " + be + "BE") +
      card("Win rate", wr === null ? "\u2014" : wr + "%", "excludes breakeven") +
      "</div>";
  }

  function card(label, value, sub) {
    return '<div class="xc"><div class="xcl">' + label + '</div>' +
      '<div class="xcv">' + value + "</div>" +
      '<div class="xcs">' + sub + "</div></div>";
  }

  // ─────────── TABLE ───────────

  function renderBody() {
    var el = document.getElementById("x-body");
    var eEl = document.getElementById("x-err");
    if (!el) return;

    if (eEl) eEl.innerHTML = STATE.err ? '<div class="xerr"><b>Could not load executions.</b><br>' + esc(STATE.err) + "</div>" : "";

    if (STATE.loading) { el.innerHTML = '<div class="xempty">Loading\u2026</div>'; return; }
    if (STATE.err) { el.innerHTML = ""; return; }
    if (!STATE.trades.length) {
      el.innerHTML = '<div class="xempty">No trades opened between ' + esc(STATE.from) +
        " and " + esc(STATE.to) + ".<br><span style=\"font-size:12.5px\">" +
        (STATE.scanned !== undefined ? STATE.scanned + " record(s) in the index were scanned." : "") +
        "</span></div>";
      return;
    }

    var h = '<div class="xtwrap"><table class="xt"><thead><tr>' +
      "<th></th><th>Opened (Mel)</th><th>Pair</th><th>Dir</th><th>Session</th>" +
      "<th>Grade</th><th>Score</th><th>R:R</th><th>Lots</th><th>Risk</th>" +
      "<th>P&amp;L</th><th>R</th><th>Ticket</th>" +
      "</tr></thead><tbody>";

    STATE.trades.forEach(function (t) {
      var c = t.context || {};
      var g = c.grade || "";
      var gc = g.indexOf("A") === 0 ? "g-A" : g === "B" ? "g-B" : g === "C" ? "g-C" : g === "F" ? "g-F" : "g-none";
      var dir = String(t.direction || "").toLowerCase();
      var rm = t.r_multiple;
      var rCls = !num(rm) ? "" : rm > 0.05 ? "pos" : rm < -0.05 ? "neg" : "flat";
      var pCls = !num(t.total_pnl) ? "" : t.total_pnl > 0 ? "pos" : t.total_pnl < 0 ? "neg" : "flat";
      var isOpen = STATE.open[t.ticket];

      var flags = "";
      if (c.auto_fail) flags += '<span class="xflag af">AUTO-FAIL</span>';
      if (c.amber) flags += '<span class="xflag am">AMBER</span>';

      h += '<tr class="xrow" onclick="mcjExecToggle(\'' + esc(t.ticket) + '\')">' +
        '<td style="color:var(--text3)">' + (isOpen ? "\u25be" : "\u25b8") + "</td>" +
        '<td class="mono">' + esc(melStamp(t.entry_time)) + "</td>" +
        '<td class="mono" style="font-weight:700">' + esc(t.symbol) +
        (t.closed ? "" : ' <span class="xopen">open</span>') + flags + "</td>" +
        '<td class="' + (dir.indexOf("buy") === 0 || dir === "long" ? "dir-long" : "dir-short") + '">' +
        esc(t.direction || "\u2014") + "</td>" +
        "<td>" + esc(sessionLabel(c.session)) + "</td>" +
        '<td><span class="xpill ' + gc + '">' + esc(g || "\u2014") + "</span></td>" +
        '<td class="mono">' + (num(c.checklist_score) ? c.checklist_score +
          (num(c.checklist_max) ? "/" + c.checklist_max : "") : "\u2014") + "</td>" +
        '<td class="mono">' + esc(c.rr && (c.rr.display || c.rr.ratio) ? (c.rr.display || c.rr.ratio) : "\u2014") + "</td>" +
        '<td class="mono">' + (num(t.lot_size) ? t.lot_size.toFixed(2) : "\u2014") + "</td>" +
        '<td class="mono">' + (num(t.risk_percent) ? t.risk_percent + "%" : "\u2014") + "</td>" +
        '<td class="mono ' + pCls + '">' + (num(t.total_pnl) && t.closed ? money(t.total_pnl) : "\u2014") + "</td>" +
        '<td class="mono ' + rCls + '">' + (num(rm) ? (rm >= 0 ? "+" : "") + rm.toFixed(2) + "R" : "\u2014") + "</td>" +
        '<td class="mono" style="color:var(--text3);font-size:11.5px">' + esc(t.ticket) + "</td>" +
        "</tr>";

      if (isOpen) h += detailRow(t, c);
    });

    h += "</tbody></table></div>";
    el.innerHTML = h;
  }

  function detailRow(t, c) {
    var hasCtx = t.context && Object.keys(t.context).length;

    var structure = hasCtx ? [
      row("D1 structure", c.d1struct), row("H4 structure", c.h4struct),
      row("D1 CHoCH", c.d1choch), row("H4 CHoCH", c.h4choch),
      row("M15 direction", c.m15dir), row("Position", posLabel(c.position)),
      row("Order type", c.order_type),
    ].join("") : '<div class="xdr"><span>Not scored</span><span>\u2014</span></div>';

    var zone = hasCtx ? [
      row("Zone level", c.zone_level),
      row("ZDS", c.zone && c.zone.zds), row("ZFI", c.zone && c.zone.zfi),
      row("ZSA", c.zone && c.zone.zsa),
    ].join("") : "";

    var scorer = hasCtx ? [
      row("Prep", c.prep_display || (num(c.prep_done) ? c.prep_done + (num(c.prep_max) ? "/" + c.prep_max : "") : null)),
      row("Trend / structure", subScore(c.trend_str)),
      row("Zone / sweep", subScore(c.zone_sweep)),
      row("Execution", subScore(c.exec)),
      row("SL room", subScore(c.sl_room)),
      row("Penalties", num(c.penalty_total) ? c.penalty_total : null),
      row("Position size", c.position_size),
    ].join("") : "";

    var rr = c.rr || {};
    var execution = [
      row("Entry price", t.entry_price),
      row("Original SL", t.original_sl),
      row("TP", t.tp_price),
      row("R:R entry", rr.entry), row("R:R stop", rr.stop),
      row("R:R target", rr.target), row("R:R ratio", rr.display || rr.ratio),
      row("Exit price", t.exit_price),
      row("Exit time", t.exit_time ? melStamp(t.exit_time) : null),
      row("Partials", t.deals && t.deals.length ? t.deals.length + " deal(s)" : null),
      row("Account", t.account),
    ].join("");

    /* checklist_saved_at is the stale-attribution guard from the handover:
       if this is a later date than the trade, the analysis shown was edited
       after the fill and may not be what was on screen at entry. */
    var savedWarn = "";
    if (c.checklist_saved_at) {
      var sd = melDateOnly(c.checklist_saved_at), td = melDateOnly(t.entry_time);
      if (sd && td && sd > td) {
        savedWarn = '<div style="grid-column:1/-1;font-size:12px;padding:8px 10px;background:#fef3c7;' +
          'border:1.5px solid #fcd34d;border-radius:6px;color:#92400e">' +
          "Checklist was last saved on " + esc(sd) + ", after this trade opened on " + esc(td) +
          " \u2014 the analysis above may reflect a later session, not the state at entry.</div>";
      }
    }

    return '<tr class="xdet"><td colspan="13"><div class="xdbox">' +
      '<div class="xdsec"><h4>Structure at entry</h4>' + structure + "</div>" +
      (zone ? '<div class="xdsec"><h4>Zone</h4>' + zone + "</div>" : "") +
      (scorer ? '<div class="xdsec"><h4>Checklist breakdown</h4>' + scorer + "</div>" : "") +
      '<div class="xdsec"><h4>Execution</h4>' + execution + "</div>" +
      (c.checklist_saved_at ? '<div class="xdsec"><h4>Provenance</h4>' +
        row("Checklist saved", melStamp(c.checklist_saved_at)) +
        row("Context stamp", c.timestamp_gmt ? melStamp(c.timestamp_gmt) : null) + "</div>" : "") +
      savedWarn +
      "</div></td></tr>";
  }

  function row(label, val) {
    if (val === null || val === undefined || val === "") return "";
    return '<div class="xdr"><span>' + esc(label) + "</span><span>" + esc(val) + "</span></div>";
  }

  // ─────────── CSV EXPORT ───────────

  window.mcjExecCsv = function () {
    if (!STATE.trades.length) { alert("Nothing to export for this period."); return; }
    var cols = ["ticket", "opened_mel", "symbol", "direction", "session", "grade", "checklist_score",
      "rr", "lots", "risk_pct", "entry", "sl", "tp", "exit", "pnl", "r_multiple", "closed",
      "position", "d1struct", "h4struct", "d1choch", "h4choch", "m15dir", "order_type",
      "zds", "zfi", "zsa", "prep", "trend_str", "zone_sweep", "exec", "sl_room",
      "penalty_total", "auto_fail", "amber", "checklist_saved_at", "account"];

    var lines = [cols.join(",")];
    STATE.trades.forEach(function (t) {
      var c = t.context || {}, rr = c.rr || {}, z = c.zone || {};
      var v = [t.ticket, melStamp(t.entry_time), t.symbol, t.direction, c.session, c.grade,
        c.checklist_score, rr.display || rr.ratio, t.lot_size, t.risk_percent,
        t.entry_price, t.original_sl, t.tp_price, t.exit_price, t.total_pnl, t.r_multiple, t.closed,
        c.position, c.d1struct, c.h4struct, c.d1choch, c.h4choch, c.m15dir, c.order_type,
        z.zds, z.zfi, z.zsa, c.prep_display, subScore(c.trend_str), subScore(c.zone_sweep),
        subScore(c.exec), subScore(c.sl_room), c.penalty_total, c.auto_fail, c.amber,
        c.checklist_saved_at, t.account];
      lines.push(v.map(function (x) {
        if (x === null || x === undefined) return "";
        var s = String(x);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(","));
    });

    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mcj-executions-" + STATE.from + "_to_" + STATE.to + ".csv";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  // ─────────── BOOT ───────────

  function start() {
    injectStyles();
    injectTab();
    var r = rangeFor("month");          // default period per step 5
    STATE.from = r.from; STATE.to = r.to;
    renderBar();
    console.log("MCJ executions tab active \u2014 default " + STATE.from + " to " + STATE.to);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
