/* ============================================================
   VPN / Proxy guard
   Blocks the site when the visitor is connecting through a
   VPN, proxy, or Tor. Detection is done by a free, no-key
   IP-intelligence API (ipquery.io) over HTTPS.

   NOTE: client-side VPN detection can never be 100% accurate.
   A determined user can bypass it. This stops casual VPN use.
   ============================================================ */
(function () {
  "use strict";

  // ---- config -------------------------------------------------
  // Treat these connection types as "VPN" and block them.
  var BLOCK = {
    vpn: true,
    proxy: true,
    tor: true,
    datacenter: false, // hosting/datacenter IPs — flip to true to be stricter
  };
  // If the detection API itself fails (offline, blocked, rate-limited):
  //   false = let the visitor in (fail-open, fewer false lockouts)
  //   true  = block until it can be checked (fail-closed, stricter)
  var BLOCK_ON_ERROR = false;
  var API_URL = "https://api.ipquery.io/?format=json";
  var TIMEOUT_MS = 6000;
  // -------------------------------------------------------------

  var root = document.documentElement;

  // Hide the page immediately so nothing flashes before the check.
  var style = document.createElement("style");
  style.textContent =
    "html.vpn-checking body{visibility:hidden!important}" +
    "#vpn-guard{position:fixed;inset:0;z-index:2147483647;display:flex;" +
    "align-items:center;justify-content:center;padding:24px;" +
    "background:#0a0d0b;color:#f3f4f1;" +
    "font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    "#vpn-guard .vg-card{max-width:460px;text-align:center}" +
    "#vpn-guard .vg-icon{font-size:46px;line-height:1;margin-bottom:18px}" +
    "#vpn-guard h1{font-size:24px;margin:0 0 12px;font-weight:800}" +
    "#vpn-guard p{margin:0 0 10px;color:#aab0a8;font-size:15px;line-height:1.55}" +
    "#vpn-guard .vg-spin{width:34px;height:34px;margin:0 auto 18px;" +
    "border:3px solid rgba(255,255,255,.15);border-top-color:#7bd88f;" +
    "border-radius:50%;animation:vgspin .8s linear infinite}" +
    "@keyframes vgspin{to{transform:rotate(360deg)}}" +
    "#vpn-guard button{margin-top:18px;padding:11px 22px;border:0;border-radius:10px;" +
    "background:#7bd88f;color:#0a0d0b;font-weight:700;font-size:15px;cursor:pointer}" +
    "#vpn-guard button:hover{filter:brightness(1.06)}";
  (document.head || root).appendChild(style);
  root.classList.add("vpn-checking");

  function makeOverlay(inner) {
    var existing = document.getElementById("vpn-guard");
    if (existing) existing.remove();
    var ov = document.createElement("div");
    ov.id = "vpn-guard";
    ov.innerHTML = '<div class="vg-card">' + inner + "</div>";
    (document.body || root).appendChild(ov);
    return ov;
  }

  // Show the "checking…" overlay right away.
  makeOverlay(
    '<div class="vg-spin"></div>' +
      "<h1>Checking your connection…</h1>" +
      "<p>Just a moment.</p>"
  );

  function allow() {
    var ov = document.getElementById("vpn-guard");
    if (ov) ov.remove();
    root.classList.remove("vpn-checking");
  }

  function blockSite() {
    makeOverlay(
      '<div class="vg-icon">🛡️</div>' +
        "<h1>Please turn off your VPN</h1>" +
        "<p>This site can’t be used while a VPN, proxy, or Tor connection is active.</p>" +
        "<p>Disable it and reload the page to continue.</p>" +
        '<button onclick="location.reload()">Reload</button>'
    );
    // keep body hidden
    root.classList.add("vpn-checking");
  }

  function check() {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      BLOCK_ON_ERROR ? blockSite() : allow();
    }, TIMEOUT_MS);

    fetch(API_URL, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("bad status " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var risk = (data && data.risk) || {};
        var flagged =
          (BLOCK.vpn && risk.is_vpn) ||
          (BLOCK.proxy && risk.is_proxy) ||
          (BLOCK.tor && risk.is_tor) ||
          (BLOCK.datacenter && risk.is_datacenter);
        flagged ? blockSite() : allow();
      })
      .catch(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        BLOCK_ON_ERROR ? blockSite() : allow();
      });
  }

  if (document.body) check();
  else
    document.addEventListener("DOMContentLoaded", function () {
      // re-anchor overlay into body now that it exists
      makeOverlay(
        '<div class="vg-spin"></div>' +
          "<h1>Checking your connection…</h1>" +
          "<p>Just a moment.</p>"
      );
      check();
    });
})();
