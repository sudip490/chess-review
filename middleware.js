/* ============================================================
   Server-side VPN / proxy block (Vercel Edge Middleware)

   Runs on Vercel's servers BEFORE the website is sent to the
   visitor. It reads the visitor's real IP, asks a VPN-detection
   service about it, and if it's a VPN/proxy/Tor/datacenter it
   returns a block page instead of the site. The visitor's
   browser cannot skip or fake this.
   ============================================================ */
import { next, ipAddress } from "@vercel/edge";

// Only guard real page visits — static assets (js/css/icons) are harmless.
export const config = {
  matcher: ["/", "/index.html"],
};

// ---- config -------------------------------------------------
var BLOCK = {
  vpn: true,
  proxy: true,
  tor: true,
  datacenter: true, // most commercial VPNs exit through datacenter IPs
};
var RISK_SCORE_BLOCK = 75; // also block if overall risk score >= this (0-100)
// If detection itself fails (service down/rate-limited):
//   false = let the visitor in (fewer false lockouts)
//   true  = block until it can be verified (stricter)
var BLOCK_ON_ERROR = false;
// -------------------------------------------------------------

const BLOCK_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turn off your VPN</title>
<style>
html,body{margin:0;height:100%}
body{display:flex;align-items:center;justify-content:center;padding:24px;
background:#0a0d0b;color:#f3f4f1;
font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.card{max-width:460px;text-align:center}
.icon{font-size:46px;margin-bottom:18px}
h1{font-size:24px;margin:0 0 12px;font-weight:800}
p{margin:0 0 10px;color:#aab0a8;font-size:15px;line-height:1.55}
button{margin-top:18px;padding:11px 22px;border:0;border-radius:10px;
background:#7bd88f;color:#0a0d0b;font-weight:700;font-size:15px;cursor:pointer}
button:hover{filter:brightness(1.06)}
</style></head><body>
<div class="card">
<div class="icon">🛡️</div>
<h1>Please turn off your VPN</h1>
<p>This site can’t be used while a VPN, proxy, or Tor connection is active.</p>
<p>Disable it and reload the page to continue.</p>
<button onclick="location.reload()">Reload</button>
</div></body></html>`;

function blockResponse() {
  return new Response(BLOCK_HTML, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async function middleware(req) {
  let ip = ipAddress(req);
  if (!ip) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) ip = xff.split(",")[0].trim();
  }
  // No IP (or localhost during dev) -> can't check, let it through.
  if (!ip || ip === "127.0.0.1" || ip === "::1") return next();

  try {
    const r = await fetch(
      "https://api.ipquery.io/" + encodeURIComponent(ip) + "?format=json",
      { cache: "no-store" }
    );
    if (!r.ok) throw new Error("bad status " + r.status);
    const data = await r.json();
    const risk = (data && data.risk) || {};
    const flagged =
      (BLOCK.vpn && risk.is_vpn) ||
      (BLOCK.proxy && risk.is_proxy) ||
      (BLOCK.tor && risk.is_tor) ||
      (BLOCK.datacenter && risk.is_datacenter) ||
      (typeof risk.risk_score === "number" &&
        risk.risk_score >= RISK_SCORE_BLOCK);
    if (flagged) return blockResponse();
    return next();
  } catch (e) {
    return BLOCK_ON_ERROR ? blockResponse() : next();
  }
}
