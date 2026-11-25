// SC Client cosmetics + chat service: plain Node, no dependencies, works on any host (VPS, Render, Koyeb, Fly, Railway...).
const http = require("http"), fs = require("fs"), crypto = require("crypto"), path = require("path");
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
const loginLog = [];   // the last failed logins: only time, Mojang's status and its reply, for /diag/mojang
const MOJANG = (process.env.MOJANG_URL || "https://sessionserver.mojang.com").replace(/\/$/, "");
const MOJANG_API = (process.env.MOJANG_API_URL || "https://api.mojang.com").replace(/\/$/, "");
/** a Minecraft username -> { u: uuid without dashes, n: name as Mojang spells it }, or null when there is no such player */
async function lookUpPlayer(name) {
  const r = await fetch(`${MOJANG_API}/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw new Error("mojang " + r.status);
  const j = await r.json();
  return /^[0-9a-f]{32}$/i.test(j.id || "") ? { u: j.id.toLowerCase(), n: cleanName(j.name) || name } : null;
}
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

function startSession(send, u, n) {
  const token = crypto.randomBytes(24).toString("hex");
  const sess = { u, n, exp: Date.now() + SESSION_TTL, lastAt: 0, times: [] };
  sess.team = teamUuids().includes(u);
  sessions.set(token, sess);
  if (soc.names[u] !== n) { soc.names[u] = n; socDirty = true; }
  return send({ token, uuid: dash(u), name: n, expiresIn: SESSION_TTL / 1000 });
}

// ---------------- sign-in with the Mojang player certificate ----------------
// Mojang gives every signed-in player a key pair and signs (uuid, expiry, public key) with its own key - the same certificate
// Minecraft uses to sign chat. The player signs our nonce with their private key. Both checks happen here, so nothing
// depends on reaching Mojang (Render's address is blocked by Mojang). mojang-keys.json and team.json are kept up to date
// by a GitHub Action (.github/workflows/mojang-keys.yml).
const readJsonFile = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")); } catch { return fallback; } };
const MOJANG_KEYS = (readJsonFile("mojang-keys.json", {}).playerCertificateKeys || []).map((k) => {
  try { return crypto.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }); } catch { return null; }
}).filter(Boolean);
const TEAM_FILE = readJsonFile("team.json", {});
const teamUuids = () => Object.values(TEAM_FILE).map((x) => String(x).toLowerCase().replace(/-/g, ""));

/** "2026-11-26T03:12:45.123456Z" -> epoch milliseconds, cut to whole milliseconds the way Java's Instant.toEpochMilli does */
function isoToMillis(iso) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/.exec(String(iso || ""));
  if (!m) return NaN;
  const ms = Number(((m[7] || "") + "000").slice(0, 3));
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + ms;
}

/** returns the player's uuid (no dashes) when the certificate is Mojang's and the nonce was signed with its key, else null */
function checkCertificate(cert, nonce, sig) {
  try {
    const u = String(cert.uuid || "").toLowerCase().replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/.test(u)) return null;
    const expires = typeof cert.expiresAtMs === "number" ? cert.expiresAtMs : isoToMillis(cert.expiresAt);
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    const der = Buffer.from(String(cert.publicKey || ""), "base64");
    const playerKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    const when = Buffer.alloc(8); when.writeBigInt64BE(BigInt(expires));
    const signed = Buffer.concat([Buffer.from(u, "hex"), when, der]);
    const mojangSig = Buffer.from(String(cert.keySig || ""), "base64");
    if (!MOJANG_KEYS.some((k) => crypto.verify("sha1", signed, k, mojangSig))) return null;
    if (!crypto.verify("sha256", Buffer.from(nonce, "utf8"), playerKey, Buffer.from(String(sig || ""), "base64"))) return null;
    return u;
  } catch { return null; }
}

async function chatRoute(req, url, send) {
  const p = url.pathname;
  // what Mojang answers this server (no player data): sessionserver should say 204 for a login that never happened
  if (p === "/chat/diag" && req.method === "GET") {
    const out = { lastLogins: loginLog.slice(-10) };
    const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const sid = crypto.randomBytes(8).toString("hex");
    for (const [k, u, ua] of [["hasJoined", `${MOJANG}/session/minecraft/hasJoined?username=Notch&serverId=${sid}`, "SCClient-service"],
                          ["hasJoinedBrowserUA", `${MOJANG}/session/minecraft/hasJoined?username=Notch&serverId=${sid}`, BROWSER],
                          ["hasJoinedJavaUA", `${MOJANG}/session/minecraft/hasJoined?username=Notch&serverId=${sid}`, "Java/21.0.5"],
                          ["sessionProfile", `${MOJANG}/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5`, "SCClient-service"],
                          ["profile", `${MOJANG_API}/users/profiles/minecraft/Notch`, "SCClient-service"],
                          ["servicesProfile", `https://api.minecraftservices.com/minecraft/profile/lookup/name/Notch`, "SCClient-service"],
                          ["publickeys", `https://api.minecraftservices.com/publickeys`, "SCClient-service"]]) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": ua } });
        const body = await r.text();
        out[k] = { status: r.status, body: body.replace(/\s+/g, " ").slice(0, k === "publickeys" ? 60 : 300) };
      } catch (e) { out[k] = { error: String(e && e.cause ? e.cause.code || e.cause : e) }; }
    }
    try { const ip = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) }); out.myIp = await ip.text(); } catch {}
    return send(out);
  }
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
    if (b.cert) {   // sign-in with the player certificate: checked here, without asking Mojang
      const u = checkCertificate(b.cert, nonce, b.sig);
      if (!u) return send({ error: "Your sign-in couldn't be checked. Sign in again in the launcher, then try again." }, 401);
      if (BANNED.has(u) || BANNED.has(dash(u))) return send({ error: "you are not allowed to chat" }, 403);
      // a team member's name only belongs to the team member's account
      if (TEAM_NAMES.some((n) => n.toLowerCase() === name.toLowerCase()) && !teamUuids().includes(u)) return send({ error: "That name isn't yours." }, 403);
      return startSession(send, u, name);
    }
    // Mojang sometimes needs a moment before it confirms a fresh login, so ask a few times before giving up
    let r = null, last = 0, lastBody = "";
    for (const wait of [0, 700, 1500, 3000]) {
      if (wait) await new Promise((ok) => setTimeout(ok, wait));
      try {
        r = await fetch(`${MOJANG}/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${nonce}`, { signal: AbortSignal.timeout(8000) });
        last = r.status;
        if (r.status === 200) break;
        lastBody = (await r.text().catch(() => "")).slice(0, 160);
      } catch { last = -1; }
    }
    if (!r || r.status !== 200) {
      console.log(`login not confirmed for ${name}: Mojang answered ${last}`);
      loginLog.push({ at: new Date().toISOString(), status: last, body: lastBody });
      if (loginLog.length > 50) loginLog.shift();
      if (last === 429) return send({ error: "Mojang is busy right now. Try again in a minute." }, 503);
      if (last === -1 || last >= 500) return send({ error: "Can't reach Mojang right now. Try again in a minute." }, 502);
      return send({ error: "Mojang didn't confirm your login. Restart the game, or sign in again in the launcher." }, 401);
    }
    let prof; try { prof = await r.json(); } catch { return send({ error: "bad answer from Mojang" }, 502); }
    const u = String(prof.id || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(u)) return send({ error: "bad answer from Mojang" }, 502);
    if (BANNED.has(u) || BANNED.has(dash(u))) return send({ error: "you are not allowed to chat" }, 403);
    return startSession(send, u, cleanName(prof.name) || name);
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
// send one message there every 14 days. Players only see the welcome, their own messages, team announcements and team replies
// to them. The team (TEAM_NAMES) sees every message from every player in that same chat and writes freely:
// a message starting with @name goes only to that player, anything else goes to everyone.
const TEAM_ID = "5c000000000000000000000000000001";
const TEAM_CHAT_NAME = "SC Client";
const TEAM_NAMES = (process.env.TEAM_NAMES || "baksya,wsammyyy").split(",").map((x) => x.trim()).filter(Boolean);
const TEAM_GAP = 14 * 24 * 3600 * 1000;
const WELCOME_FROM = "baksya & wsammyyy";
const WELCOME = "We're baksya and wsammyyy, the creators of SC Client. If you have any questions, feel free to ask them in this chat. " +
  "Be careful what you send, because you can only send one message here every 14 days.";
const isTeam = (s) => teamUuids().includes(s.u);
const faces = () => teamUuids().map(dash);
let soc = { names: {}, friends: {}, req: [], dms: {}, read: {}, team: { feed: [], seq: 1, sent: {} } };   // names: uuid -> name, friends: uuid -> [uuid], req: [{f,t}], dms: pair -> {last,msgs}, read: "uuid|pair" -> id, team: the SC Client chat
function teamOf(c) {
  const t = c.team || {};
  const out = { feed: Array.isArray(t.feed) ? t.feed : [], seq: Number(t.seq) || 1, sent: t.sent || {} };
  for (const [u, th] of Object.entries(t.threads || {}))   // older layout: one thread per player
    for (const m of th.msgs || []) out.feed.push({ id: ++out.seq, t: m.t, f: m.f, to: m.f === u ? "team" : u, m: m.m });
  out.feed.sort((a, b) => a.id - b.id);
  return out;
}
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

// chat filter for the SC Client chat: blocks slurs and swearing (also with spacing/symbols/leetspeak); add more with BLOCKED_WORDS
const BLOCKED = ["nigger","nigga","faggot","fag","retard","tranny","kike","chink","spic","wetback","coon","dyke",
  "fuck","shit","bitch","cunt","dick","cock","pussy","asshole","bastard","whore","slut","porn","nude","nudes","sex","rape",
  "kys","killyourself"].concat((process.env.BLOCKED_WORDS || "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean));
const LEET = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g" };
function blocked(text) {
  const low = text.toLowerCase().replace(/[0-9!|@$]/g, (c) => LEET[c] || c);
  const parts = low.split(/[^a-z]+/).filter(Boolean), words = [];
  for (const x of parts) {   // "f u c k" -> "fuck"
    if (x.length === 1 && words.length && words[words.length - 1].single) words[words.length - 1].w += x;
    else words.push({ w: x, single: x.length === 1 });
  }
  for (const x of parts) words.push({ w: x });
  for (let i = 0; i < words.length; i++) words[i] = words[i].w;
  const squashed = low.replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
  return BLOCKED.some((w) => words.includes(w) || words.some((x) => x.replace(/(.)\1+/g, "$1") === w.replace(/(.)\1+/g, "$1")) ||
    (w.length >= 5 && squashed.includes(w.replace(/(.)\1+/g, "$1"))));
}
const WELCOME_MSG = { id: 1, t: 0, f: "team", to: null, m: WELCOME };
// what a player sees: the welcome, team announcements, their own messages and team replies to them. The team sees everything.
const seesTeamMsg = (m, me, team) => team || m.to === null || m.f === me || m.to === me;
function teamFeed(me, team) { return [WELCOME_MSG, ...soc.team.feed].filter((m) => seesTeamMsg(m, me, team)); }
function teamOut(m, me, team) {
  let text = m.m;
  if (team && m.to && m.to !== "team") text = "@" + nameOf(m.to) + " " + text;   // the team sees who a reply went to
  return { id: m.id, t: m.t, m: text, n: m.f === "team" ? WELCOME_FROM : nameOf(m.f), mine: m.f === me };
}
const teamUnread = (me, team) => { const seen = soc.read[me + "|team"] || 0; return teamFeed(me, team).filter((m) => m.id > seen && m.f !== me).length; };
function markTeamRead(me) { if ((soc.read[me + "|team"] || 0) < soc.team.seq) { soc.read[me + "|team"] = soc.team.seq; socDirty = true; } }
const TEAM_KEEP = 3000;

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
      friends: [{ u: dash(TEAM_ID), n: TEAM_CHAT_NAME, online: true, unread: teamUnread(me, !!s.team), faces: faces(), team: true, limited: !s.team },
        ...friendsOf(me).map((f) => ({ u: dash(f), n: nameOf(f), online: online(f), unread: dmUnread(f) })).sort((a, b) => (b.online - a.online) || a.n.localeCompare(b.n))],
      incoming: soc.req.filter((r) => r.t === me).map((r) => ({ u: dash(r.f), n: nameOf(r.f) })),
      outgoing: soc.req.filter((r) => r.f === me).map((r) => ({ u: dash(r.t), n: nameOf(r.t) })),
    });
  }
  if (req.method !== "POST" && p !== "/social/dm/get") return send({ error: "not found" }, 404);
  if (p === "/social/dm/get" && req.method === "GET") {
    const f = norm(url.searchParams.get("u"));
    const after = Number(url.searchParams.get("after")) || 0;
    if (f === TEAM_ID) {
      const msgs = teamFeed(me, !!s.team).filter((m) => m.id > after).slice(-150).map((m) => teamOut(m, me, !!s.team));
      markTeamRead(me);
      return send({ messages: msgs, last: soc.team.seq });
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
    if (!want) return send({ error: "Type a Minecraft username." }, 400);
    let t = Object.keys(soc.names).find((u) => soc.names[u].toLowerCase() === want);
    const given = norm(b.u);   // the game / launcher looked the name up with Mojang itself (this server can't reach Mojang)
    if (!t && isId(given)) { t = given; if (!soc.names[t]) { soc.names[t] = cleanName(b.name); socDirty = true; } }
    if (!t) {   // never used SC Client yet: find them through Mojang, they'll see the request when they first open friends
      let found;
      try { found = await lookUpPlayer(want); } catch { return send({ error: "Couldn't look that player up right now. Try again in a minute." }, 502); }
      if (!found) return send({ error: "There's no Minecraft player with that name." }, 404);
      t = found.u;
      if (!soc.names[t]) { soc.names[t] = found.n; socDirty = true; }
    }
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
  if (other === TEAM_ID) {
    if (p !== "/social/dm/send") return send({ error: "The SC Client chat can't be changed." }, 400);
    let text = cleanText(b.text);
    if (!text) return send({ error: "empty message" }, 400);
    let to = "team";
    if (s.team) {
      to = null;   // the team: an announcement to everyone, or "@name ..." for one player
      const at = /^@([A-Za-z0-9_]{1,16})\s+(.+)$/.exec(text);
      if (at) {
        const want = at[1].toLowerCase();
        const u = Object.keys(soc.names).find((x) => soc.names[x].toLowerCase() === want);
        if (!u) return send({ error: `No player called ${at[1]} has used the chat.` }, 404);
        to = u; text = at[2];
      }
    } else {
      if (blocked(text)) return send({ error: "That message has words that aren't allowed here. It wasn't sent, and you can still send one." }, 400);
      const wait = (soc.team.sent[me] || 0) + TEAM_GAP - Date.now();
      if (wait > 0) {
        const days = Math.ceil(wait / (24 * 3600 * 1000));
        return send({ error: `You can send one message here every 14 days. Try again in ${days} day${days === 1 ? "" : "s"}.` }, 429);
      }
    }
    if (!rateOk(s)) return send({ error: "too fast" }, 429);
    const id = ++soc.team.seq;
    soc.team.feed.push({ id, t: Date.now(), f: me, to, m: text });
    if (soc.team.feed.length > TEAM_KEEP) soc.team.feed.splice(0, soc.team.feed.length - TEAM_KEEP);
    if (!s.team) soc.team.sent[me] = Date.now();
    socDirty = true; return send({ ok: true, id });
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
  res.writeHead(200, CORS); res.end("SC Client service");
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
