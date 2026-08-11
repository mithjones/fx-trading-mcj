/**
 * mcj-mo-staging.js  —  Taken-trade review queue for the MO Tracker
 *
 * Live trades from MT5 do NOT write straight into the Taken grid. They land
 * in a staging panel with editable dropdowns, mirroring how Quick Capture
 * parses speech and waits for you to verify before logging.
 *
 * Load AFTER mcj-live-risk.js, immediately before </body>.
 *
 * WHY A QUEUE RATHER THAN DIRECT WRITES
 *   setTK() is `if(st) tkData.push(...)` — a blank setup code silently writes
 *   nothing. Setup code cannot be derived from MT5 (it's your own taxonomy),
 *   so every trade needs one field from you regardless. The queue makes that
 *   explicit instead of dropping trades on the floor.
 *
 * SESSION ASSIGNMENT
 *   Your session windows are not contiguous (gaps 12:00-15:00, 19:00-22:00,
 *   02:00-08:00 Melbourne). Trades landing in a gap are assigned to the
 *   NEAREST window by edge distance, measured circularly across midnight,
 *   with ties broken toward the EARLIER session (the trade was already live
 *   by then). Any inferred session is flagged in the panel.
 */

(function () {
  "use strict";

var WORKER = "https://fx-proxy.mwwakista.workers.dev";
var API_KEY = "xk29LqPz84mNwRt7";   // ← your actual random string, not this example
  var POLL_MS = 120000;
  var LS_KEY = "mcj_mo_stage_v1";     // queue survives reloads
  var LS_DONE = "mcj_mo_stage_done";  // tickets already committed or dismissed

  var STAGE = [];
  var MEL = "Australia/Sydney";

  /* MO session index (0-8) with Melbourne minute-of-day windows, derived from
     the FX suite's SESSIONS array. Note FX has two NY Open rows spanning
     midnight; both map to MO index 7. */
  var WINDOWS = [
    { mo: 0, s: 480,  e: 540,  label: "Pre Tokyo" },
    { mo: 1, s: 540,  e: 660,  label: "Tokyo Open" },
    { mo: 2, s: 660,  e: 720,  label: "Mid Tokyo" },
    { mo: 3, s: 900,  e: 960,  label: "Pre London" },
    { mo: 4, s: 960,  e: 1020, label: "Ldn Open" },
    { mo: 5, s: 1020, e: 1140, label: "Mid London" },
    { mo: 6, s: 1320, e: 1380, label: "Pre NY" },
    { mo: 7, s: 1380, e: 1440, label: "NY Open" },
    { mo: 7, s: 0,    e: 60,   label: "NY Open" },
    { mo: 8, s: 60,   e: 120,  label: "Ldn/NY Rev" }
  ];

  function hdrs() { return { "Content-Type": "application/json", "X-MCJ-Key": API_KEY }; }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ─────────── TIME → DAY + SESSION ───────────

  function melParts(iso) {
    var d = new Date(iso);
    var f = new Intl.DateTimeFormat("en-GB", {
      timeZone: MEL, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short"
    });
    var p = {};
    f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
    return {
      y: Number(p.year), m: Number(p.month), d: Number(p.day),
      minutes: hour * 60 + Number(p.minute),
      weekday: p.weekday
    };
  }

  /* Circular distance in minutes between a point and a window edge. */
  function circDist(a, b) {
    var raw = Math.abs(a - b);
    return Math.min(raw, 1440 - raw);
  }

  function assignSession(minutes) {
    for (var i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i];
      if (minutes >= w.s && minutes < w.e) {
        return { si: w.mo, label: w.label, inferred: false };
      }
    }
    // Outside every window: nearest edge wins, earlier session on a tie.
    var best = null, bestD = Infinity;
    WINDOWS.forEach(function (w) {
      var d = Math.min(circDist(minutes, w.s), circDist(minutes, w.e));
      if (d < bestD) { bestD = d; best = w; }
    });
    return { si: best.mo, label: best.label, inferred: true, gapMins: bestD };
  }

  function mondayOf(p) {
    var utc = Date.UTC(p.y, p.m - 1, p.d);
    var idx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
    var mon = new Date(utc - idx * 86400000);
    return mon.getUTCFullYear() + "-" + pad2(mon.getUTCMonth() + 1) + "-" + pad2(mon.getUTCDate());
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* MO pair labels carry a slash; the Worker stores them stripped. */
  function toPairLabel(sym) {
    if (typeof window.allPairs === "function") {
      var match = window.allPairs().find(function (p) {
        return p.replace(/\//g, "").toUpperCase() === sym.toUpperCase();
      });
      if (match) return match;
    }
    return sym.length === 6 ? sym.slice(0, 3) + "/" + sym.slice(3) : sym;
  }

  function outcomeOf(t) {
    if (!t.closed) return "Pending";
    var r = t.r_multiple;
    if (typeof r === "number") {
      if (Math.abs(r) < 0.05) return "BE";
      return r < 0 ? "Loss" : "Win";
    }
    if (typeof t.total_pnl === "number") {
      if (t.total_pnl === 0) return "BE";
      return t.total_pnl < 0 ? "Loss" : "Win";
    }
    return "Pending";
  }

  // ─────────── BUILD STAGE ROWS ───────────

  function stageFromTrades(trades) {
    var done = lsGet(LS_DONE, []);
    var existing = {};
    STAGE.forEach(function (r) { existing[r.ticket] = r; });
    var added = 0;

    trades.forEach(function (t) {
      if ((t.account || "personal") !== "personal") return;
      if (done.indexOf(t.ticket) > -1) return;

      var p = melParts(t.entry_time);
      var sess = assignSession(p.minutes);
      var warnings = [];

      if (sess.inferred) {
        warnings.push("Session inferred — entry at " +
          Math.floor(p.minutes / 60) + ":" + pad2(p.minutes % 60) +
          " fell outside any window (nearest: " + sess.label + ", " + sess.gapMins + " min away)");
      }
      if (p.weekday === "Sat" || p.weekday === "Sun") {
        warnings.push("Weekend entry (" + p.weekday + ") — MO tracker only has Mon-Fri, assign manually");
      }
      if (!t.closed) warnings.push("Still open — outcome will stay Pending");

      var wkKey = mondayOf(p);
      var currentWk = (typeof window.wk === "function") ? window.wk() : null;
      if (currentWk && wkKey !== currentWk) {
        warnings.push("Belongs to week " + wkKey + ", not the week you're viewing");
      }

      var row = existing[t.ticket];
      if (row) {
        // Refresh only the outcome — never clobber edits already made here.
        row.oc = outcomeOf(t);
        row.closed = t.closed;
        row.warnings = warnings;
        return;
      }

      STAGE.push({
        ticket: t.ticket,
        raw: toPairLabel(t.symbol) + " " + (t.direction === "buy" ? "Long" : "Short") +
             " · " + p.weekday + " " + Math.floor(p.minutes / 60) + ":" + pad2(p.minutes % 60) +
             " · " + (t.closed ? (t.r_multiple !== null ? t.r_multiple + "R" : "closed") : "open"),
        w: wkKey,
        day: ["Sat", "Sun"].indexOf(p.weekday) > -1 ? "" : p.weekday,
        p: toPairLabel(t.symbol),
        si: sess.si,
        st: "",                       // your taxonomy — must be chosen before commit
        dr: t.direction === "buy" ? "Long" : "Short",
        oc: outcomeOf(t),
        closed: t.closed,
        r: t.r_multiple,
        pnl: t.total_pnl,
        inferredSession: sess.inferred,
        warnings: warnings
      });
      added++;
    });

    if (added) lsSet(LS_KEY, STAGE);
    return added;
  }

  // ─────────── PANEL ───────────

  function ensurePanel() {
    var host = document.getElementById("mo-app");
    if (!host) return null;
    var panel = document.getElementById("mcj-stage");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "mcj-stage";
      panel.style.cssText = "margin:12px 0;";
      host.insertBefore(panel, host.firstChild);
    }
    return panel;
  }

  function render() {
    var panel = ensurePanel();
    if (!panel) return;

    if (!STAGE.length) { panel.innerHTML = ""; return; }

    var ready = STAGE.filter(isReady).length;
    var h = '<div style="border:1px solid #E0A32E;background:#FFFBF0;border-radius:8px;padding:12px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
      '<strong style="font-size:13px;color:#7A4B00">⚡ ' + STAGE.length +
      ' trade' + (STAGE.length === 1 ? "" : "s") + ' from MT5 awaiting review</strong>' +
      '<span style="font-size:11px;opacity:.7">Pick a setup code for each, then log.</span>' +
      '</div>';

    STAGE.forEach(function (r, ix) {
      var ok = isReady(r);
      h += '<div style="border:1px solid ' + (ok ? "#CBD5E1" : "#E74C3C") +
           ';border-radius:6px;padding:8px;margin-bottom:6px;background:#fff">' +
           '<div style="font-size:11px;font-family:monospace;opacity:.75;margin-bottom:6px">' +
           esc(r.raw) + '</div><div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">';

      h += sel(ix, "day", "Day", r.day, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
      h += sel(ix, "p", "Pair", r.p, typeof window.allPairs === "function" ? window.allPairs() : [r.p]);
      h += sel(ix, "si", "Session", r.si,
        (typeof window.SS !== "undefined" ? window.SS : []).map(function (s, i) { return { v: i, t: s }; }));
      h += sel(ix, "st", "Setup", r.st,
        (typeof window.setups !== "undefined" ? window.setups : []).map(function (x) { return x.code; }));
      h += sel(ix, "dr", "Dir", r.dr, ["Long", "Short"]);
      h += sel(ix, "oc", "Outcome", r.oc, ["Win", "Loss", "BE", "Pending"]);

      h += '</div>';
      if (r.warnings && r.warnings.length)
        h += '<div style="font-size:10.5px;color:#92400E;margin-top:5px">' +
             esc(r.warnings.join(" · ")) + '</div>';
      if (!r.st)
        h += '<div style="font-size:10.5px;color:#991B1B;margin-top:4px">Setup code required — ' +
             'the tracker discards entries without one.</div>';
      h += '<button style="margin-top:6px;font-size:11px;padding:2px 8px;border:1px solid #CBD5E1;' +
           'border-radius:4px;background:#F8FAFC;cursor:pointer" ' +
           'onclick="mcjStageDrop(' + ix + ')">Dismiss</button>';
      h += '</div>';
    });

    h += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
      '<button ' + (ready ? "" : "disabled ") +
      'style="font-size:12px;font-weight:700;padding:5px 12px;border-radius:5px;border:none;cursor:' +
      (ready ? "pointer" : "not-allowed") + ';background:' + (ready ? "#166534" : "#CBD5E1") +
      ';color:#fff" onclick="mcjStageCommit()">Log ' + ready + ' trade' + (ready === 1 ? "" : "s") + '</button>' +
      '<button style="font-size:12px;padding:5px 10px;border:1px solid #CBD5E1;border-radius:5px;' +
      'background:#fff;cursor:pointer" onclick="mcjStageClear()">Dismiss all</button></div></div>';

    panel.innerHTML = h;
  }

  function sel(ix, field, label, val, opts) {
    var o = '<option value="">' + label + "?</option>";
    (opts || []).forEach(function (x) {
      var v = (typeof x === "object") ? x.v : x;
      var t = (typeof x === "object") ? x.t : x;
      o += '<option value="' + String(v).replace(/"/g, "&quot;") + '"' +
           (String(val) === String(v) ? " selected" : "") + ">" + esc(t) + "</option>";
    });
    var isSet = val !== "" && val !== null && val !== undefined;
    return '<select onchange="mcjStageEdit(' + ix + ',\'' + field + '\',this.value)" ' +
      'style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid ' +
      (isSet ? "#86EFAC" : "#E74C3C") + ';background:' + (isSet ? "#F0FDF4" : "#FFF5F5") + '">' + o + "</select>";
  }

  function isReady(r) {
    return !!(r.p && r.si !== null && r.si !== "" && r.day && r.st);
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ─────────── ACTIONS ───────────

  window.mcjStageEdit = function (ix, field, val) {
    var r = STAGE[ix];
    if (!r) return;
    r[field] = (field === "si") ? (val === "" ? null : Number(val)) : val;
    lsSet(LS_KEY, STAGE);
    render();
  };

  window.mcjStageDrop = function (ix) {
    var r = STAGE[ix];
    if (r) markDone(r.ticket);
    STAGE.splice(ix, 1);
    lsSet(LS_KEY, STAGE);
    render();
  };

  window.mcjStageClear = function () {
    if (!confirm("Dismiss all " + STAGE.length + " staged trades without logging?")) return;
    STAGE.forEach(function (r) { markDone(r.ticket); });
    STAGE = [];
    lsSet(LS_KEY, STAGE);
    render();
  };

  /*
   * Writes directly into tkData with an explicit week key rather than calling
   * setTK(), which reads the global `day` and `wk()`. Going through setTK
   * would misfile any trade from a week other than the one on screen.
   * Collision rule (your choice): newest wins on the same w|d|p|si.
   */
  window.mcjStageCommit = function () {
    if (typeof window.tkData === "undefined") {
      alert("MO Tracker data not loaded — open the MO Tracker section first.");
      return;
    }
    var logged = 0, skipped = 0;

    STAGE.slice().forEach(function (r) {
      if (!isReady(r)) { skipped++; return; }

      window.tkData = window.tkData.filter(function (e) {
        return !(e.w === r.w && e.d === r.day && e.p === r.p && e.si === r.si);
      });
      window.tkData.push({
        w: r.w, d: r.day, p: r.p, si: r.si,
        st: r.st, dr: r.dr || "", oc: r.oc || "",
        ts: Date.now()
      });

      markDone(r.ticket);
      logged++;
    });

    STAGE = STAGE.filter(function (r) { return !isReady(r); });
    lsSet(LS_KEY, STAGE);

    if (typeof window.persist === "function") window.persist();
    ["buildGrid", "buildPairGrid", "renderPairSidebar", "renderAnalytics"].forEach(function (fn) {
      if (typeof window[fn] === "function") { try { window[fn](); } catch (e) {} }
    });

    render();
    var msg = "Logged " + logged + " trade" + (logged === 1 ? "" : "s") +
              (skipped ? ", " + skipped + " still need a setup code" : "");
    if (typeof window.toast === "function") window.toast(msg, 3000); else console.log(msg);
  };

  function markDone(ticket) {
    var done = lsGet(LS_DONE, []);
    if (done.indexOf(ticket) === -1) {
      done.push(ticket);
      lsSet(LS_DONE, done.slice(-1000));
    }
  }

  // ─────────── POLL ───────────

  function poll() {
    fetch(WORKER + "/journal?limit=100", { headers: hdrs() })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        var added = stageFromTrades(payload.trades || []);
        render();
        if (added && typeof window.toast === "function")
          window.toast(added + " trade" + (added === 1 ? "" : "s") + " ready to review in MO Tracker", 3000);
      })
      .catch(function (e) { console.warn("MCJ MO staging:", e.message); });
  }

  function boot() {
    STAGE = lsGet(LS_KEY, []);
    render();
    poll();
    setInterval(poll, POLL_MS);
    console.log("MCJ MO staging active");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
