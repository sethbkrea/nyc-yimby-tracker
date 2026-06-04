#!/usr/bin/env node
/**
 * One-time helper: sign in with Google in your browser and print the Supabase
 * REFRESH TOKEN to paste into Vercel as SUPABASE_REFRESH_TOKEN.
 *
 *   node scripts/get-refresh-token.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const SUPABASE_URL = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const ALLOWED_EMAIL = "seth@bkrea.com";
const PORT = 53682;
const REDIRECT_TO = `http://localhost:${PORT}/callback`;

const HTML = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh">
<div id="m">Finishing…</div><script>
fetch("/finish",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:location.hash.slice(1)})
 .then(()=>document.getElementById("m").innerHTML="<h2>Done ✓</h2><p>Return to your terminal.</p>")
 .catch(()=>document.getElementById("m").textContent="Failed — check terminal.");
</script></body>`;

function open(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* manual */ }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/callback") {
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(HTML); return;
  }
  if (req.method === "POST" && url.pathname === "/finish") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const p = new URLSearchParams(body);
        const access_token = p.get("access_token");
        const refresh_token = p.get("refresh_token");
        if (!refresh_token || !access_token) throw new Error("no tokens in callback");
        const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY } }).then((r) => r.json());
        if ((u.email ?? "").toLowerCase() !== ALLOWED_EMAIL) throw new Error(`signed in as ${u.email}, expected ${ALLOWED_EMAIL}`);
        res.writeHead(200); res.end("ok");
        console.log("\n✓ Signed in as", u.email, "\n");
        console.log("Set this in Vercel (Project → Settings → Environment Variables):\n");
        console.log("SUPABASE_REFRESH_TOKEN=" + refresh_token + "\n");
        server.close(); process.exit(0);
      } catch (e) {
        res.writeHead(500); res.end("error");
        console.error("Failed:", e.message); server.close(); process.exit(1);
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(REDIRECT_TO)}`;
  console.error("Opening browser for Google sign-in… if it doesn't open, visit:\n" + authUrl + "\n");
  open(authUrl);
});
setTimeout(() => { console.error("Timed out."); process.exit(1); }, 5 * 60 * 1000);
