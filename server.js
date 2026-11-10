// Chrome Client cosmetics service: plain Node, no dependencies, works on any host (VPS, Render, Koyeb, Fly, Railway...).
const http = require("http"), fs = require("fs");
const FILE = process.env.DATA_FILE || "data.json";
const PORT = process.env.PORT || 8080;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 60 * 24 * 3600 * 1000;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const num = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let dirty = false;
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(db)) if (now - db[k].t > TTL) { delete db[k]; dirty = true; }
  if (dirty) { try { fs.writeFileSync(FILE, JSON.stringify(db)); dirty = false; } catch {} }
}, 30000);

http.createServer((req, res) => {
  const send = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(o)); };
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/set" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(body); } catch { return send({ error: "bad json" }, 400); }
      const u = String(b.u || "").toLowerCase();
      if (!UUID.test(u)) return send({ error: "bad uuid" }, 400);
      db[u] = { t: Date.now(), h: num(b.h, 40), c: num(b.c, 40), w: num(b.w, 40), e: num(b.e, 40), ew: num(b.ew, 5),
        ea: Math.max(0.1, Math.min(1, Number(b.ea) || 0.5)), eo: b.eo !== false };
      dirty = true; send({ ok: true });
    });
    return;
  }
  if (url.pathname === "/get" && req.method === "GET") {
    const ids = (url.searchParams.get("u") || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)).slice(0, 50);
    const out = {};
    for (const id of ids) if (db[id]) { const { t, ...d } = db[id]; out[id] = d; }
    return send(out);
  }
  res.writeHead(200, CORS); res.end("Chrome Client cosmetics service");
}).listen(PORT, () => console.log("listening on " + PORT));
