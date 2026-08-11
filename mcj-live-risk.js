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
      session: d.session || undefined,
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

  function buildContext(pair, ticket) {
    if (typeof window.getPair !== "function") return null;
    var d = window.getPair(pair) || {};

    var score = null, grade = null, posSize = null, autoFail = null, amber = null;
    if (typeof window.calculateSetupScore === "function") {
      try {
        var res = window.calculateSetupScore(d.setup, d.zone);
        if (res && res.hasAny) {
          score = typeof res.total === "number" ? res.total : null;
          grade = res.grade || null;
          posSize = res.positionSize || null;
          autoFail = res.autoFail || null;
          amber = !!res.amber;
        }
      } catch (e) {}
    }

    // Nothing scored and no structure set => no real context to attach.
    var hasAny = d.d1struct || d.h4struct || d.position || score !== null;
    if (!hasAny) return null;

    return {
      ticket: String(ticket),
      symbol: String(pair).replace(/\//g, "").toUpperCase(),
      timestamp_gmt: new Date().toISOString(),
      d1struct: d.d1struct || undefined,
      h4struct: d.h4struct || undefined,
      d1choch: d.d1choch || undefined,
      h4choch: d.h4choch || undefined,
      m15dir: d.m15dir || undefined,
      position: d.position || undefined,
      order_type: d.ot || undefined,
      session: d.session || undefined,
      zone: d.zone ? { zds: d.zone.zds, zfi: d.zone.zfi, zsa: d.zone.zsa } : undefined,
      checklist_score: score,
      grade: grade,
      position_size: posSize,
      auto_fail: autoFail,
      amber: amber,
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
      '<span style="cursor:pointer;opacity:.5;font-size:16px" onclick="mcjCloseActivity()">&times;</span></div>';

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
        '<tr style="text-align:left;opacity:.55"><th>Pair</th><th>Dir</th><th>R</th><th>P&L</th><th>Setup</th></tr>';
      TRADES.slice(0, 25).forEach(function (t) {
        var r = t.r_multiple;
        var rCol = r === null || r === undefined ? "#475569" : r > 0.05 ? "#166534" : r < -0.05 ? "#B91C1C" : "#B45309";
        var ctx = t.context;
        var setup = ctx
          ? (ctx.grade || "?") + (ctx.position ? " · " + shortPos(ctx.position) : "")
          : '<span style="opacity:.45">not scored</span>';
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
