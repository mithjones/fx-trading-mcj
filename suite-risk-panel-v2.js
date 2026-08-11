/**
 * suite-risk-panel-v2.js  —  MCJ Trading Suite risk panel
 *
 * Paste into MCJ_Trading_Suite.html, or load via <script src="...">.
 *
 * REQUIRED HTML:
 *   <div id="mcj-risk-panel"></div>
 *   <button id="mcj-enable-push">Enable alerts on this device</button>
 *
 * CONFIG: set MCJ_API_KEY below.
 *   SECURITY NOTE, stated plainly: GitHub Pages serves this file publicly,
 *   so anyone who views source can read this key. It protects the MT5 write
 *   path (that key lives only on your VPS) and stops casual scraping, but it
 *   is NOT real protection for the read path. If the journal contents matter,
 *   put Cloudflare Access in front of the Suite instead of relying on this.
 */

const MCJ_WORKER = "https://fx-proxy.mwwakista.workers.dev";
const MCJ_API_KEY = "mcj-trading-secret-8271-kj";
const MCJ_VAPID_PUBLIC = "BO35Ge3eNx-SL4Rn02YUQNXFB_wLSOguVeY8DAsBAOWcmYhCCA7GF_AHSDGdu5vSAl9TiKHclnVYVHm4aH3wKtY";
const MCJ_POLL_MS = 60000;
const MCJ_SW_PATH = "/fx-trading-mcj/sw.js"; // project-page path, not site root

let mcjLastAlertKey = null;

// ---------------- Push registration ----------------
// MUST be triggered by a user gesture: Safari rejects permission requests
// made on page load, and Chrome increasingly penalises them.

async function mcjEnablePush() {
  const btn = document.getElementById("mcj-enable-push");
  const say = (msg) => { if (btn) btn.textContent = msg; };

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    say("Push not supported — using in-app alerts");
    return;
  }
  if (!window.isSecureContext) {
    say("Push needs HTTPS");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register(MCJ_SW_PATH);
    await navigator.serviceWorker.ready;

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      say("Alerts blocked — using in-app banner only");
      return;
    }

    const existing = await reg.pushManager.getSubscription();
    const sub = existing || (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: mcjB64ToU8(MCJ_VAPID_PUBLIC),
    }));

    const res = await fetch(`${MCJ_WORKER}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCJ-Key": MCJ_API_KEY },
      body: JSON.stringify(sub),
    });
    say(res.ok ? "Alerts enabled ✓" : `Subscribe failed (${res.status})`);
  } catch (err) {
    console.error("MCJ: push setup failed", err);
    say("Push setup failed — see console");
  }
}

function mcjB64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---------------- Polling ----------------

async function mcjPoll() {
  try {
    const res = await fetch(`${MCJ_WORKER}/risk`, { headers: { "X-MCJ-Key": MCJ_API_KEY } });
    if (res.status === 401) return mcjRenderError("Unauthorized — check MCJ_API_KEY");
    if (!res.ok) return mcjRenderError(`Worker error ${res.status}`);

    const { risk, alerts, caps } = await res.json();
    mcjRender(risk, alerts, caps);

    // In-app fallback so a missed push still surfaces once the tab is open
    if (alerts.length) {
      const key = alerts[0].triggered_at + alerts[0].type;
      if (mcjLastAlertKey && key !== mcjLastAlertKey) mcjFlashBanner(alerts[0]);
      mcjLastAlertKey = key;
    }
  } catch (err) {
    console.error("MCJ: poll failed", err);
    mcjRenderError("Cannot reach Worker — offline?");
  }
}

function mcjRenderError(msg) {
  const el = document.getElementById("mcj-risk-panel");
  if (el) el.innerHTML = `<div style="padding:12px;border-radius:8px;background:#3a2a1f;color:#f0d9b5;">
    Risk monitor unavailable: ${mcjEsc(msg)}</div>`;
}

function mcjRender(risk, alerts, caps) {
  const el = document.getElementById("mcj-risk-panel");
  if (!el) return;

  const streakBad = risk.streak >= 2;
  const dailyPct = risk.daily_pnl_percent;
  const weeklyPct = risk.weekly_pnl_percent;
  const dailyBad = dailyPct !== null && dailyPct <= caps.daily;
  const weeklyBad = weeklyPct !== null && weeklyPct <= caps.weekly;
  const bad = streakBad || dailyBad || weeklyBad;

  const bg = bad ? "#3d1d1d" : "#1c2a1c";
  const border = bad ? "#a33" : "#3a5";

  const warn = [];
  if (risk.heartbeat_stale) warn.push("EA heartbeat stale — figures may be out of date (VPS offline?)");
  if (risk.daily_baseline_inferred) warn.push("Daily baseline set late — drawdown % approximate");

  el.innerHTML = `
    <div style="padding:14px;border-radius:10px;background:${bg};border:1px solid ${border};
                color:#eee;font-family:system-ui,sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:1.05em;">${bad ? "⚠ Risk limit reached" : "Risk status: normal"}</strong>
        <span style="font-size:0.75em;opacity:0.6;">
          ${risk.heartbeat_at ? new Date(risk.heartbeat_at).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney" }) : "no data"}
        </span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px;font-size:0.9em;">
        ${mcjStat("Loss streak", risk.streak, streakBad, risk.streak >= 2 ? "reduce size" : "")}
        ${mcjStat("Today", mcjPct(dailyPct), dailyBad, `cap ${caps.daily}%`)}
        ${mcjStat("This week", mcjPct(weeklyPct), weeklyBad, `cap ${caps.weekly}%`)}
      </div>

      ${mcjBar("Daily", dailyPct, caps.daily)}
      ${mcjBar("Weekly", weeklyPct, caps.weekly)}

      <div style="margin-top:10px;font-size:0.8em;opacity:0.75;">
        Equity ${mcjNum(risk.equity)} · Balance ${mcjNum(risk.balance)} ·
        Floating ${mcjNum(risk.floating_pnl)} · ${risk.open_positions ?? 0} open
      </div>

      ${warn.map((w) => `<div style="margin-top:8px;padding:6px 8px;border-radius:6px;
        background:#4a3a1a;font-size:0.8em;">${mcjEsc(w)}</div>`).join("")}

      ${alerts.length ? `<div style="margin-top:12px;">
        <div style="font-size:0.75em;text-transform:uppercase;opacity:0.6;">Recent alerts</div>
        <ul style="margin:6px 0 0;padding-left:18px;font-size:0.82em;line-height:1.5;">
          ${alerts.slice(0, 6).map((a) => `<li>
            <span style="opacity:0.6;">${new Date(a.triggered_at).toLocaleString("en-AU",
              { timeZone: "Australia/Sydney", day: "2-digit", month: "short",
                hour: "2-digit", minute: "2-digit" })}</span>
            — ${mcjEsc(a.message)}</li>`).join("")}
        </ul></div>` : ""}
    </div>`;
}

function mcjStat(label, value, bad, note) {
  return `<div style="padding:8px;border-radius:6px;background:rgba(0,0,0,0.25);">
    <div style="font-size:0.7em;text-transform:uppercase;opacity:0.6;">${label}</div>
    <div style="font-size:1.3em;font-weight:600;color:${bad ? "#ff8b8b" : "#d8f0d8"};">${value}</div>
    ${note ? `<div style="font-size:0.68em;opacity:0.55;">${mcjEsc(note)}</div>` : ""}
  </div>`;
}

function mcjBar(label, pct, cap) {
  if (pct === null || pct === undefined) return "";
  const used = Math.min(Math.max((pct / cap) * 100, 0), 100); // pct and cap both negative
  const color = used >= 100 ? "#e05555" : used >= 66 ? "#e0a355" : "#5aa85a";
  return `<div style="margin-top:8px;">
    <div style="display:flex;justify-content:space-between;font-size:0.7em;opacity:0.6;">
      <span>${label} cap usage</span><span>${Math.round(used)}%</span></div>
    <div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.12);margin-top:3px;">
      <div style="height:100%;width:${used}%;background:${color};border-radius:3px;"></div>
    </div></div>`;
}

function mcjFlashBanner(alert) {
  const d = document.createElement("div");
  d.style.cssText = `position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;
    background:#b33;color:#fff;padding:12px 18px;border-radius:8px;font-family:system-ui,sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,0.4);max-width:90vw;font-size:0.9em;`;
  d.textContent = alert.message;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 15000);
}

const mcjPct = (p) => (p === null || p === undefined ? "—" : `${p > 0 ? "+" : ""}${p}%`);
const mcjNum = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-AU",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function mcjEsc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

// ---------------- Boot ----------------
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("mcj-enable-push");
  if (btn) btn.addEventListener("click", mcjEnablePush);

  // Reflect existing permission state without prompting
  if ("Notification" in window && Notification.permission === "granted" && btn)
    btn.textContent = "Alerts enabled ✓";

  mcjPoll();
  setInterval(mcjPoll, MCJ_POLL_MS);
});
