// sw.js — MCJ Trading Suite service worker
//
// WHERE THIS GOES: the root of your repo, so GitHub Pages serves it at
//   https://mithjones.github.io/fx-trading-mcj/sw.js
//
// SET THIS to the same key used everywhere else:
var MCJ_API_KEY = "REPLACE_WITH_YOUR_MCJ_API_KEY";
var MCJ_WORKER  = "https://fx-proxy.mithila-wakista.workers.dev";
var MCJ_APP     = "/fx-trading-mcj/";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

/*
 * The Worker sends a push with no payload (encrypting one would need a lot of
 * fragile crypto). So on wake-up we fetch the current alert ourselves. Upside:
 * the notification always shows the latest state, not a stale snapshot.
 */
self.addEventListener("push", function (event) {
  event.waitUntil(
    fetch(MCJ_WORKER + "/risk", { headers: { "X-MCJ-Key": MCJ_API_KEY } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var a = (data.alerts && data.alerts[0]) || null;
        var risk = data.risk || {};

        var title = a ? titleFor(a.type) : "MCJ Trading Suite";
        var body = a ? a.message : "New alert — open the Suite for details.";

        // Context line so the notification is actionable without opening the app
        var bits = [];
        if (typeof risk.streak === "number" && risk.streak > 0) bits.push(risk.streak + " loss streak");
        if (typeof risk.trades_today === "number") bits.push(risk.trades_today + " trades today");
        if (risk.daily_pnl_percent !== null && risk.daily_pnl_percent !== undefined)
          bits.push("day " + risk.daily_pnl_percent + "%");
        if (bits.length) body += "\n" + bits.join(" · ");

        return self.registration.showNotification(title, {
          body: body,
          tag: "mcj-alert",
          renotify: true,
          requireInteraction: a && a.severity === "critical",
          data: { url: MCJ_APP }
        });
      })
      .catch(function (err) {
        // Browsers require a visible notification for every push received,
        // so show a fallback rather than silently swallowing it.
        console.error("MCJ sw: fetch failed", err);
        return self.registration.showNotification("MCJ Trading Suite", {
          body: "A risk alert fired — open the Suite for details.",
          tag: "mcj-alert",
          data: { url: MCJ_APP }
        });
      })
  );
});

function titleFor(type) {
  return {
    loss_streak: "MCJ — Loss Streak",
    daily_drawdown: "MCJ — Daily Cap Hit",
    weekly_drawdown: "MCJ — Weekly Cap Hit",
    trade_count_limit: "MCJ — Daily Limit Reached",
    trade_count_exceeded: "MCJ — Daily Limit Exceeded",
    price_alert: "MCJ — Price Alert"
  }[type] || "MCJ Alert";
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || MCJ_APP;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(MCJ_APP) > -1 && "focus" in list[i]) return list[i].focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
