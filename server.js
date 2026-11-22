// Chrome Client cosmetics service: plain Node, no dependencies, works on any host (VPS, Render, Koyeb, Fly, Railway...).
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const FILE = process.env.DATA_FILE || "data.json";
const PORT = process.env.PORT || 8080;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 60 * 24 * 3600 * 1000;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const num = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let dirty = false;
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(db)) if (now - db[k].t > TTL) { delete db[k]; dirty = true; }
  if (dirty) { try { fs.writeFileSync(FILE, JSON.stringify(db)); dirty = false; } catch {} }
}, 30000);

// ---------------- chat ----------------
// One shared room for everyone using Chrome Client. Players prove who they are with Mojang's own login check (the same one
// Minecraft servers use), so nobody can type as somebody else: /chat/nonce -> the game calls joinServer with it -> /chat/login.
const CHAT_FILE = process.env.CHAT_FILE || "chat.json";
const MOJANG = (process.env.MOJANG_URL || "https://sessionserver.mojang.com").replace(/\/$/, "");
const BANNED = new Set((process.env.CHAT_BANNED || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));   // uuids, no dashes
const KEEP = 300;            // messages kept
const MAX_LEN = 200;         // characters in a message
const MIN_GAP = 1200;        // ms between two messages from one player
const PER_MIN = 20;          // messages per minute per player
const NONCE_TTL = 60 * 1000, SESSION_TTL = 12 * 3600 * 1000;

let chat = { last: 0, msgs: [] };
try { const c = JSON.parse(fs.readFileSync(CHAT_FILE, "utf8")); if (c && Array.isArray(c.msgs)) chat = { last: Number(c.last) || 0, msgs: c.msgs.slice(-KEEP) }; } catch {}
let chatDirty = false;
const nonces = new Map();     // nonce -> expires
const sessions = new Map();   // token -> { u, n, exp, lastAt, times: [] }
const ipHits = new Map();     // ip -> [timestamps]

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of ipHits) { const keep = v.filter((t) => now - t < 60000); if (keep.length) ipHits.set(k, keep); else ipHits.delete(k); }
  if (chatDirty) { try { fs.writeFileSync(CHAT_FILE, JSON.stringify(chat)); chatDirty = false; } catch {} }
}, 15000);

function tooManyFromIp(req, limit) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const list = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); ipHits.set(ip, list);
  return list.length > limit;
}
function readJson(req, max = 2048) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > max) { req.destroy(); reject(new Error("too big")); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
const dash = (id) => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const cleanName = (n) => String(n || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
function cleanText(t) {
  return String(t || "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
}
function sessionOf(req) {
  const m = /^Bearer ([0-9a-f]{48})$/.exec(String(req.headers.authorization || ""));
  const s = m && sessions.get(m[1]);
  return s && s.exp > Date.now() ? s : null;
}

async function chatRoute(req, url, send) {
  const p = url.pathname;
  if (p === "/chat/nonce" && req.method === "POST") {
    if (tooManyFromIp(req, 30)) return send({ error: "slow down" }, 429);
    const nonce = crypto.randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL);
    return send({ nonce });
  }
  if (p === "/chat/login" && req.method === "POST") {
    if (tooManyFromIp(req, 30)) return send({ error: "slow down" }, 429);
    let b; try { b = await readJson(req); } catch (e) { return send({ error: e.message }, 400); }
    const name = cleanName(b.name), nonce = String(b.nonce || "");
    const exp = nonces.get(nonce);
    if (!name || !exp || exp < Date.now()) return send({ error: "bad or old nonce" }, 400);
    nonces.delete(nonce);   // one use only
    let r;
    try {
      r = await fetch(`${MOJANG}/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${nonce}`, { signal: AbortSignal.timeout(8000) });
    } catch { return send({ error: "could not reach Mojang" }, 502); }
    if (r.status !== 200) return send({ error: "Mojang did not confirm this login" }, 401);
    let prof; try { prof = await r.json(); } catch { return send({ error: "bad answer from Mojang" }, 502); }
    const u = String(prof.id || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(u)) return send({ error: "bad answer from Mojang" }, 502);
    if (BANNED.has(u) || BANNED.has(dash(u))) return send({ error: "you are not allowed to chat" }, 403);
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { u, n: cleanName(prof.name) || name, exp: Date.now() + SESSION_TTL, lastAt: 0, times: [] });
    if (soc.names[u] !== (cleanName(prof.name) || name)) { soc.names[u] = cleanName(prof.name) || name; socDirty = true; }
    return send({ token, uuid: dash(u), name: cleanName(prof.name) || name, expiresIn: SESSION_TTL / 1000 });
  }
  const s = sessionOf(req);
  if (!s) return send({ error: "sign in first" }, 401);
  if (BANNED.has(s.u)) return send({ error: "you are not allowed to chat" }, 403);
  lastSeen.set(s.u, Date.now());
  if (p.startsWith("/social/")) return socialRoute(req, url, send, s);
  if (p === "/chat/get" && req.method === "GET") {
    const after = Number(url.searchParams.get("after")) || 0;
    const out = chat.msgs.filter((m) => m.id > after).slice(-100);
    return send({ messages: out, last: chat.last });
  }
  if (p === "/chat/send" && req.method === "POST") {
    let b; try { b = await readJson(req); } catch (e) { return send({ error: e.message }, 400); }
    const text = cleanText(b.text);
    if (!text) return send({ error: "empty message" }, 400);
    const now = Date.now();
    s.times = s.times.filter((t) => now - t < 60000);
    if (now - s.lastAt < MIN_GAP || s.times.length >= PER_MIN) return send({ error: "too fast" }, 429);
    s.lastAt = now; s.times.push(now);
    const m = { id: ++chat.last, t: now, u: dash(s.u), n: s.n, m: text };
    chat.msgs.push(m); if (chat.msgs.length > KEEP) chat.msgs.splice(0, chat.msgs.length - KEEP);
    chatDirty = true;
    return send({ ok: true, id: m.id });
  }
  return send({ error: "not found" }, 404);
}

// ---------------- friends and direct messages ----------------
// Same sign-in as the chat room. Friends need both sides to agree (request -> accept). Only friends can message each other.
const SOCIAL_FILE = process.env.SOCIAL_FILE || "social.json";
const MAX_FRIENDS = 100, MAX_PENDING = 30, DM_KEEP = 200;
let soc = { names: {}, friends: {}, req: [], dms: {}, read: {} };   // names: uuid -> name, friends: uuid -> [uuid], req: [{f,t}], dms: pair -> {last,msgs}, read: "uuid|pair" -> id
try { const c = JSON.parse(fs.readFileSync(SOCIAL_FILE, "utf8")); if (c && c.names) soc = { names: c.names, friends: c.friends || {}, req: c.req || [], dms: c.dms || {}, read: c.read || {} }; } catch {}
let socDirty = false;
const lastSeen = new Map();   // uuid -> ms of the last call, for the green dot
setInterval(() => { if (socDirty) { try { fs.writeFileSync(SOCIAL_FILE, JSON.stringify(soc)); socDirty = false; } catch {} } }, 15000);

const norm = (x) => String(x || "").replace(/-/g, "").toLowerCase();
const isId = (x) => /^[0-9a-f]{32}$/.test(x);
const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
const friendsOf = (u) => soc.friends[u] || (soc.friends[u] = []);
const areFriends = (a, b) => friendsOf(a).includes(b);
const nameOf = (u) => soc.names[u] || "Unknown";
const online = (u) => Date.now() - (lastSeen.get(u) || 0) < 45000;
const rateOk = (s) => {
  const now = Date.now();
  s.times = s.times.filter((t) => now - t < 60000);
  if (now - s.lastAt < MIN_GAP || s.times.length >= PER_MIN) return false;
  s.lastAt = now; s.times.push(now); return true;
};
function removeRequests(a, b) { const n = soc.req.length; soc.req = soc.req.filter((r) => !((r.f === a && r.t === b) || (r.f === b && r.t === a))); return soc.req.length !== n; }
function befriend(a, b) {
  if (!areFriends(a, b)) friendsOf(a).push(b);
  if (!areFriends(b, a)) friendsOf(b).push(a);
}

async function socialRoute(req, url, send, s) {
  const p = url.pathname, me = s.u;
  if (p === "/social/state" && req.method === "GET") {
    const dmUnread = (f) => {
      const key = pairKey(me, f), t = soc.dms[key];
      if (!t) return 0;
      const seen = soc.read[me + "|" + key] || 0;
      return t.msgs.filter((m) => m.id > seen && m.f !== me).length;
    };
    return send({
      friends: friendsOf(me).map((f) => ({ u: dash(f), n: nameOf(f), online: online(f), unread: dmUnread(f) })).sort((a, b) => (b.online - a.online) || a.n.localeCompare(b.n)),
      incoming: soc.req.filter((r) => r.t === me).map((r) => ({ u: dash(r.f), n: nameOf(r.f) })),
      outgoing: soc.req.filter((r) => r.f === me).map((r) => ({ u: dash(r.t), n: nameOf(r.t) })),
    });
  }
  if (req.method !== "POST" && p !== "/social/dm/get") return send({ error: "not found" }, 404);
  if (p === "/social/dm/get" && req.method === "GET") {
    const f = norm(url.searchParams.get("u"));
    if (!isId(f) || !areFriends(me, f)) return send({ error: "not friends" }, 403);
    const key = pairKey(me, f), t = soc.dms[key] || { last: 0, msgs: [] };
    const after = Number(url.searchParams.get("after")) || 0;
    const out = t.msgs.filter((m) => m.id > after).slice(-100).map((m) => ({ id: m.id, t: m.t, n: m.f === me ? s.n : nameOf(m.f), m: m.m, mine: m.f === me }));
    if (t.last > (soc.read[me + "|" + key] || 0)) { soc.read[me + "|" + key] = t.last; socDirty = true; }
    return send({ messages: out, last: t.last });
  }
  let b; try { b = await readJson(req); } catch (e) { return send({ error: e.message }, 400); }
  if (p === "/social/request") {
    const want = cleanName(b.name).toLowerCase();
    const t = Object.keys(soc.names).find((u) => soc.names[u].toLowerCase() === want);
    if (!want || !t) return send({ error: "That player has not used Chrome Client chat yet." }, 404);
    if (t === me) return send({ error: "That is you." }, 400);
    if (BANNED.has(t)) return send({ error: "That player cannot be added." }, 403);
    if (areFriends(me, t)) return send({ error: "Already friends." }, 400);
    if (friendsOf(me).length >= MAX_FRIENDS) return send({ error: "Your friend list is full." }, 400);
    if (soc.req.some((r) => r.f === t && r.t === me)) { removeRequests(me, t); befriend(me, t); socDirty = true; return send({ ok: true, friends: true }); }   // they asked you first: now you are friends
    if (soc.req.some((r) => r.f === me && r.t === t)) return send({ error: "Request already sent." }, 400);
    if (soc.req.filter((r) => r.f === me).length >= MAX_PENDING) return send({ error: "Too many open requests." }, 400);
    soc.req.push({ f: me, t });
    socDirty = true; return send({ ok: true });
  }
  const other = norm(b.u);
  if (!isId(other)) return send({ error: "bad player" }, 400);
  if (p === "/social/accept") {
    if (!soc.req.some((r) => r.f === other && r.t === me)) return send({ error: "No such request." }, 404);
    if (friendsOf(me).length >= MAX_FRIENDS) return send({ error: "Your friend list is full." }, 400);
    removeRequests(me, other); befriend(me, other); socDirty = true; return send({ ok: true });
  }
  if (p === "/social/decline" || p === "/social/cancel") {   // decline an incoming one, or take back one you sent
    removeRequests(me, other); socDirty = true; return send({ ok: true });
  }
  if (p === "/social/remove") {
    soc.friends[me] = friendsOf(me).filter((x) => x !== other);
    soc.friends[other] = friendsOf(other).filter((x) => x !== me);
    delete soc.dms[pairKey(me, other)]; socDirty = true; return send({ ok: true });
  }
  if (p === "/social/dm/send") {
    if (!areFriends(me, other)) return send({ error: "You can only message friends." }, 403);
    const text = cleanText(b.text);
    if (!text) return send({ error: "empty message" }, 400);
    if (!rateOk(s)) return send({ error: "too fast" }, 429);
    const key = pairKey(me, other), t = soc.dms[key] || (soc.dms[key] = { last: 0, msgs: [] });
    t.msgs.push({ id: ++t.last, t: Date.now(), f: me, m: text });
    if (t.msgs.length > DM_KEEP) t.msgs.splice(0, t.msgs.length - DM_KEEP);
    socDirty = true; return send({ ok: true, id: t.last });
  }
  return send({ error: "not found" }, 404);
}

http.createServer((req, res) => {
  const send = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(o)); };
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/chat/") || url.pathname.startsWith("/social/")) { chatRoute(req, url, send).catch(() => send({ error: "server error" }, 500)); return; }
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
