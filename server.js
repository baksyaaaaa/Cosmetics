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

// ---------------- saved copy on GitHub ----------------
// Free hosts (Render...) wipe their disk on every restart. With GITHUB_TOKEN and DATA_REPO set, everything is also saved
// to that (private!) repo about once a minute and loaded from it on start, so nothing is lost.
const GH_TOKEN = process.env.GITHUB_TOKEN || "", GH_REPO = process.env.DATA_REPO || "", GH_BRANCH = process.env.DATA_BRANCH || "main";
const GH_ON = Boolean(GH_TOKEN && GH_REPO);
const GH_API = (process.env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
const SAVE_EVERY = Number(process.env.SAVE_EVERY_MS) || 60000;
let ghReady = false;          // only save to GitHub after it was read successfully (never overwrite it with an empty start)
const ghSha = {}, ghLast = {};
function gh(path, opt = {}) {
  return fetch(`${GH_API}/repos/${GH_REPO}/contents/${path}`, {
    ...opt,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, "User-Agent": "chrome-client-cosmetics", Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", ...(opt.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
}
async function ghLoad(name) {   // the parsed file, or null when it isn't there yet
  const r = await gh(`${name}?ref=${encodeURIComponent(GH_BRANCH)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub said ${r.status} for ${name}`);
  const j = await r.json();
  ghSha[name] = j.sha;
  let text;
  if (j.encoding === "base64" && j.content) text = Buffer.from(j.content, "base64").toString("utf8");
  else {   // files over 1 MB come without content: ask for the raw file
    const raw = await gh(`${name}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: { Accept: "application/vnd.github.raw" } });
    if (!raw.ok) throw new Error(`GitHub said ${raw.status} for ${name}`);
    text = await raw.text();
  }
  ghLast[name] = text;
  return JSON.parse(text);
}
async function ghSave(name, text) {
  if (!GH_ON || !ghReady || ghLast[name] === text) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { message: `save ${name}`, content: Buffer.from(text).toString("base64"), branch: GH_BRANCH };
    if (ghSha[name]) body.sha = ghSha[name];
    const r = await gh(name, { method: "PUT", body: JSON.stringify(body) });
    if (r.ok) { ghSha[name] = (await r.json()).content.sha; ghLast[name] = text; return; }
    if (r.status === 409 || r.status === 422) {   // the saved copy moved on: get its current version and try again
      const m = await gh(`${name}?ref=${encodeURIComponent(GH_BRANCH)}`);
      if (m.ok) ghSha[name] = (await m.json()).sha; else if (m.status === 404) delete ghSha[name];
      continue;
    }
    throw new Error(`GitHub save of ${name} failed: ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
  }
}
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(db)) if (now - db[k].t > TTL) { delete db[k]; dirty = true; }
  if (dirty) { try { fs.writeFileSync(FILE, JSON.stringify(db)); dirty = false; } catch {} }
}, 30000);

// ---------------- chat ----------------
// Players prove who they are with Mojang's own login check (the same one Minecraft servers use), so nobody can type as
// somebody else: /chat/nonce -> the game calls joinServer with it -> /chat/login. (There is no public room: only friends can talk.)
const MOJANG = (process.env.MOJANG_URL || "https://sessionserver.mojang.com").replace(/\/$/, "");
const BANNED = new Set((process.env.CHAT_BANNED || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));   // uuids, no dashes
const MAX_LEN = 200;         // characters in a message
const MIN_GAP = 1200;        // ms between two messages from one player
const PER_MIN = 20;          // messages per minute per player
const NONCE_TTL = 60 * 1000, SESSION_TTL = 12 * 3600 * 1000;

const nonces = new Map();     // nonce -> expires
const sessions = new Map();   // token -> { u, n, exp, lastAt, times: [] }
const ipHits = new Map();     // ip -> [timestamps]

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of ipHits) { const keep = v.filter((t) => now - t < 60000); if (keep.length) ipHits.set(k, keep); else ipHits.delete(k); }
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
    const sess = { u, n: cleanName(prof.name) || name, exp: Date.now() + SESSION_TTL, lastAt: 0, times: [] };
    sess.team = isTeam(sess);
    sessions.set(token, sess);
    if (soc.names[u] !== (cleanName(prof.name) || name)) { soc.names[u] = cleanName(prof.name) || name; socDirty = true; }
    return send({ token, uuid: dash(u), name: cleanName(prof.name) || name, expiresIn: SESSION_TTL / 1000 });
  }
  const s = sessionOf(req);
  if (!s) return send({ error: "sign in first" }, 401);
  if (BANNED.has(s.u)) return send({ error: "you are not allowed to chat" }, 403);
  lastSeen.set(s.u, Date.now());
  if (p.startsWith("/social/")) return socialRoute(req, url, send, s);
  return send({ error: "not found" }, 404);
}

// ---------------- friends and direct messages ----------------
// Same sign-in as the chat room. Friends need both sides to agree (request -> accept). Only friends can message each other.
const SOCIAL_FILE = process.env.SOCIAL_FILE || "social.json";
const MAX_FRIENDS = 100, MAX_PENDING = 30, DM_KEEP = 200;

// ---------------- the SC Client team chat ----------------
// Every player has an "SC Client" chat at the top of their friends list: it opens with the welcome below, and a player can
// send one message there every 14 days. The team (TEAM_NAMES) sees each player who wrote as their own chat and can answer freely.
const TEAM_ID = "5c000000000000000000000000000001";
const TEAM_CHAT_NAME = "SC Client";
const TEAM_NAMES = (process.env.TEAM_NAMES || "baksya,wsammyyy").split(",").map((x) => x.trim()).filter(Boolean);
const TEAM_GAP = 14 * 24 * 3600 * 1000;
const WELCOME_FROM = "baksya & wsammyyy";
const WELCOME = "We're baksya and wsammyyy, the creators of SC Client. If you have any questions, feel free to ask them in this chat. " +
  "Be careful what you send, because you can only send one message here every 14 days.";
const teamFaces = new Map();   // lower-case name -> uuid (no dashes), looked up from Mojang
async function lookUpTeamFaces() {
  for (const name of TEAM_NAMES) {
    try {
      const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); if (/^[0-9a-f]{32}$/i.test(j.id || "")) teamFaces.set(name.toLowerCase(), j.id.toLowerCase()); }
    } catch {}
  }
}
lookUpTeamFaces(); setInterval(lookUpTeamFaces, 6 * 3600 * 1000);
const isTeam = (s) => TEAM_NAMES.some((n) => n.toLowerCase() === String(s.n || "").toLowerCase()) || [...teamFaces.values()].includes(s.u);
const faces = () => TEAM_NAMES.map((n) => teamFaces.get(n.toLowerCase())).filter(Boolean).map(dash);
let soc = { names: {}, friends: {}, req: [], dms: {}, read: {}, team: { threads: {}, sent: {}, ids: {} } };   // names: uuid -> name, friends: uuid -> [uuid], req: [{f,t}], dms: pair -> {last,msgs}, read: "uuid|pair" -> id, team: the SC Client chat
const teamOf = (c) => ({ threads: (c.team && c.team.threads) || {}, sent: (c.team && c.team.sent) || {}, ids: (c.team && c.team.ids) || {} });
try { const c = JSON.parse(fs.readFileSync(SOCIAL_FILE, "utf8")); if (c && c.names) soc = { names: c.names, friends: c.friends || {}, req: c.req || [], dms: c.dms || {}, read: c.read || {}, team: teamOf(c) }; } catch {}
let socDirty = false;
const lastSeen = new Map();   // uuid -> ms of the last call, for the green dot
setInterval(() => { if (socDirty) { try { fs.writeFileSync(SOCIAL_FILE, JSON.stringify(soc)); socDirty = false; } catch {} } }, 15000);
const useSocial = (c) => { if (c && c.names) soc = { names: c.names, friends: c.friends || {}, req: c.req || [], dms: c.dms || {}, read: c.read || {}, team: teamOf(c) }; };

// save to GitHub about once a minute, and once more when the host stops the server
let saving = false;
async function saveAll() {
  if (saving) return;
  saving = true;
  try {
    await ghSave("data.json", JSON.stringify(db));
    await ghSave("social.json", JSON.stringify(soc));
  } catch (e) { console.error(String(e.message || e)); }
  finally { saving = false; }
}
setInterval(saveAll, SAVE_EVERY);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  try { fs.writeFileSync(FILE, JSON.stringify(db)); fs.writeFileSync(SOCIAL_FILE, JSON.stringify(soc)); } catch {}
  saving = false;
  await Promise.race([saveAll(), new Promise((r) => setTimeout(r, 8000))]);
  process.exit(0);
});

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

// the team's view: each player's chat with the team gets its own id ("5c" + 30 hex), kept in soc.team.ids
function supportId(u) {
  const id = "5c" + crypto.createHash("sha256").update("team|" + u).digest("hex").slice(0, 30);
  if (soc.team.ids[id] !== u) { soc.team.ids[id] = u; socDirty = true; }
  return id;
}
const teamThread = (u) => soc.team.threads[u] || (soc.team.threads[u] = { last: 1, msgs: [] });   // id 1 is the welcome
function teamView(u, viewer, teamSide) {
  const t = soc.team.threads[u] || { last: 1, msgs: [] };
  const all = [{ id: 1, t: 0, f: "team", m: WELCOME }, ...t.msgs];
  return all.map((m) => ({
    id: m.id, t: m.t, m: m.m,
    n: m.f === "team" ? WELCOME_FROM : m.f === u ? nameOf(u) : nameOf(m.f),
    mine: teamSide ? m.f !== u : m.f === viewer,
  }));
}
function teamUnread(u, teamSide) {
  const t = soc.team.threads[u] || { last: 1, msgs: [] };
  const key = teamSide ? "team-staff|" + u : u + "|team";
  const seen = soc.read[key] || 0;
  return [{ id: 1, f: "team" }, ...t.msgs].filter((m) => m.id > seen && (teamSide ? m.f === u : m.f !== u)).length;
}
function markTeamRead(u, teamSide) {
  const t = soc.team.threads[u] || { last: 1 };
  const key = teamSide ? "team-staff|" + u : u + "|team";
  if ((soc.read[key] || 0) < t.last) { soc.read[key] = t.last; socDirty = true; }
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
    const team = s.team ? Object.keys(soc.team.threads).filter((u) => u !== me && soc.team.threads[u].msgs.some((m) => m.f === u))
      .map((u) => ({ u: dash(supportId(u)), n: "Help: " + nameOf(u), online: online(u), unread: teamUnread(u, true), faces: [dash(u)] }))
      .sort((a, b) => b.unread - a.unread || a.n.localeCompare(b.n)) : [];
    return send({
      friends: [{ u: dash(TEAM_ID), n: TEAM_CHAT_NAME, online: true, unread: teamUnread(me, false), faces: faces(), team: true }, ...team,
        ...friendsOf(me).map((f) => ({ u: dash(f), n: nameOf(f), online: online(f), unread: dmUnread(f) })).sort((a, b) => (b.online - a.online) || a.n.localeCompare(b.n))],
      incoming: soc.req.filter((r) => r.t === me).map((r) => ({ u: dash(r.f), n: nameOf(r.f) })),
      outgoing: soc.req.filter((r) => r.f === me).map((r) => ({ u: dash(r.t), n: nameOf(r.t) })),
    });
  }
  if (req.method !== "POST" && p !== "/social/dm/get") return send({ error: "not found" }, 404);
  if (p === "/social/dm/get" && req.method === "GET") {
    const f = norm(url.searchParams.get("u"));
    const after = Number(url.searchParams.get("after")) || 0;
    if (f === TEAM_ID || (s.team && soc.team.ids[f])) {
      const who = f === TEAM_ID ? me : soc.team.ids[f], staff = f !== TEAM_ID;
      const msgs = teamView(who, me, staff).filter((m) => m.id > after).slice(-100);
      markTeamRead(who, staff);
      return send({ messages: msgs, last: (soc.team.threads[who] || { last: 1 }).last });
    }
    if (!isId(f) || !areFriends(me, f)) return send({ error: "not friends" }, 403);
    const key = pairKey(me, f), t = soc.dms[key] || { last: 0, msgs: [] };
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
  if (other === TEAM_ID || (s.team && soc.team.ids[other])) {
    if (p !== "/social/dm/send") return send({ error: "The SC Client chat can't be changed." }, 400);
    const text = cleanText(b.text);
    if (!text) return send({ error: "empty message" }, 400);
    const staff = other !== TEAM_ID, who = staff ? soc.team.ids[other] : me;
    if (!staff && !s.team) {
      const wait = (soc.team.sent[me] || 0) + TEAM_GAP - Date.now();
      if (wait > 0) {
        const days = Math.ceil(wait / (24 * 3600 * 1000));
        return send({ error: `You can send one message here every 14 days. Try again in ${days} day${days === 1 ? "" : "s"}.` }, 429);
      }
    }
    if (!rateOk(s)) return send({ error: "too fast" }, 429);
    const t = teamThread(who);
    t.msgs.push({ id: ++t.last, t: Date.now(), f: me, m: text });
    if (t.msgs.length > DM_KEEP) t.msgs.splice(0, t.msgs.length - DM_KEEP);
    if (!staff && !s.team) soc.team.sent[me] = Date.now();
    markTeamRead(who, staff);   // what you sent is read on your side
    socDirty = true; return send({ ok: true, id: t.last });
  }
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

const server = http.createServer((req, res) => {
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
  if (url.pathname === "/health") return send({ ok: true, saved: GH_ON ? (ghReady ? "github" : "github (not loaded yet)") : "disk only" });
  res.writeHead(200, CORS); res.end("Chrome Client cosmetics service");
});

// load the saved copy from GitHub first (a few tries), then start answering
(async () => {
  if (GH_ON) {
    for (let attempt = 1; attempt <= 5 && !ghReady; attempt++) {
      try {
        const d = await ghLoad("data.json");
        const c = await ghLoad("social.json");
        if (d && typeof d === "object") db = d;
        useSocial(c);
        ghReady = true;
        console.log(`loaded the saved copy from ${GH_REPO} (${Object.keys(db).length} players, ${Object.keys(soc.names).length} names)`);
      } catch (e) {
        console.error(`couldn't load from GitHub (try ${attempt}): ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    if (!ghReady) console.error("starting WITHOUT the GitHub copy; it won't be overwritten until a restart loads it");
  } else {
    console.log("GITHUB_TOKEN / DATA_REPO not set: saving to this server's disk only (lost when a free host restarts)");
  }
  server.listen(PORT, () => console.log("listening on " + PORT));
})();
