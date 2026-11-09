// Local dev backend: static file server + tiny document store over WebSocket.
// Mirrors the subset of Firestore semantics the app uses. Not for production.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "site"));
const PORT = +(process.argv[3] || 8787);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/__reset") { docs.clear(); vers.clear(); docs.set("config/secret", { pin: "123456" }); res.end("reset"); return; }
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(f).pipe(res);
});

const docs = new Map(); // path -> data
const vers = new Map(); // path -> version
const subs = new Map(); // ws -> Map(id -> {kind, path, opts})

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isSentinel = (v, k) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && k in v;
function resolve(v, old) {
  if (isSentinel(v, "__ts")) return Date.now();
  if (isSentinel(v, "__inc")) return (typeof old === "number" ? old : 0) + v.__inc;
  if (Array.isArray(v)) return v.map((x) => resolve(x));
  if (v && typeof v === "object") { const o = {}; for (const k in v) { if (!isSentinel(v[k], "__del")) o[k] = resolve(v[k], old && old[k]); } return o; }
  return v;
}
function applyPatch(base, patch) {
  const out = clone(base) || {};
  for (const key of Object.keys(patch)) {
    const parts = key.split(".");
    let o = out;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
    const last = parts[parts.length - 1];
    if (isSentinel(patch[key], "__del")) delete o[last];
    else o[last] = resolve(patch[key], o[last]);
  }
  return out;
}
function mergeDeep(base, data) {
  const out = clone(base) || {};
  for (const k in data) {
    const v = data[k];
    if (isSentinel(v, "__del")) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && !isSentinel(v, "__ts") && !isSentinel(v, "__inc")) out[k] = mergeDeep(out[k], v);
    else out[k] = resolve(v, out[k]);
  }
  return out;
}
const parent = (p) => p.split("/").slice(0, -1).join("/");
const get = (obj, f) => f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function queryColl(cpath, opts = {}) {
  let rows = [];
  for (const [p, d] of docs) if (parent(p) === cpath) rows.push({ id: p.split("/").pop(), ...clone(d) });
  for (const [f, op, v] of opts.where || []) {
    rows = rows.filter((r) => {
      const x = get(r, f);
      return op === "==" ? x === v : op === "<=" ? x <= v : op === ">=" ? x >= v : op === "<" ? x < v : op === ">" ? x > v : op === "!=" ? x !== v : true;
    });
  }
  if (opts.orderBy) { const [f, dir] = opts.orderBy; rows.sort((a, b) => ((get(a, f) > get(b, f) ? 1 : -1) * (dir === "desc" ? -1 : 1))); }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}
function write(p, data) {
  if (data === null) docs.delete(p); else docs.set(p, data);
  vers.set(p, (vers.get(p) || 0) + 1);
}
function notify(paths) {
  const ps = new Set(paths);
  for (const [ws, m] of subs) {
    for (const [id, s] of m) {
      if (s.kind === "doc" && ps.has(s.path)) ws.send(JSON.stringify({ sub: id, data: clone(docs.get(s.path)) ?? null }));
      if (s.kind === "coll" && [...ps].some((p) => parent(p) === s.path)) ws.send(JSON.stringify({ sub: id, data: queryColl(s.path, s.opts) }));
    }
  }
}
function doOp(o) {
  if (o.op === "delete") { write(o.path, null); return; }
  if (o.op === "create") {
    if (docs.has(o.path)) throw new Error("already-exists");
    if (o.path.startsWith("staff/") && (o.data || {}).pin !== (docs.get("config/secret") || {}).pin) throw new Error("permission-denied"); write(o.path, resolve(o.data)); return; }
  if (o.op === "update") { if (!docs.has(o.path)) throw new Error("not-found"); write(o.path, applyPatch(docs.get(o.path), o.data)); return; }
  write(o.path, o.merge ? mergeDeep(docs.get(o.path), o.data) : resolve(o.data));
}

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  subs.set(ws, new Map());
  ws.on("close", () => subs.delete(ws));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const reply = (data) => ws.send(JSON.stringify({ id: m.id, data }));
    const fail = (e) => ws.send(JSON.stringify({ id: m.id, error: String(e.message || e) }));
    try {
      switch (m.type) {
        case "now": return reply(Date.now());
        case "get": return reply(clone(docs.get(m.path)) ?? null);
        case "list": return reply(queryColl(m.path, m.opts));
        case "count": return reply(queryColl(m.path, m.opts).length);
        case "set": doOp({ op: "set", path: m.path, data: m.data, merge: m.merge }); notify([m.path]); return reply(true);
        case "update": doOp({ op: "update", path: m.path, data: m.data }); notify([m.path]); return reply(true);
        case "create": doOp({ op: "create", path: m.path, data: m.data }); notify([m.path]); return reply(true);
        case "delete": doOp({ op: "delete", path: m.path }); notify([m.path]); return reply(true);
        case "batch": {
          const snapshot = new Map(docs);
          try { m.ops.forEach(doOp); } catch (e) { docs.clear(); snapshot.forEach((v, k) => docs.set(k, v)); throw e; }
          notify(m.ops.map((o) => o.path)); return reply(true);
        }
        case "txget": return reply({ data: clone(docs.get(m.path)) ?? null, ver: vers.get(m.path) || 0 });
        case "txcommit": {
          if ((vers.get(m.path) || 0) !== m.ver) return reply(false);
          doOp({ op: docs.has(m.path) ? "update" : "set", path: m.path, data: m.data }); notify([m.path]); return reply(true);
        }
        case "subdoc": subs.get(ws).set(m.id, { kind: "doc", path: m.path }); ws.send(JSON.stringify({ sub: m.id, data: clone(docs.get(m.path)) ?? null })); return;
        case "subcoll": subs.get(ws).set(m.id, { kind: "coll", path: m.path, opts: m.opts }); ws.send(JSON.stringify({ sub: m.id, data: queryColl(m.path, m.opts) })); return;
        case "unsub": subs.get(ws)?.delete(m.id); return;
        default: return fail(new Error("unknown " + m.type));
      }
    } catch (e) { fail(e); }
  });
});

// seed the staff PIN for local testing
docs.set("config/secret", { pin: "123456" });
server.listen(PORT, () => console.log(`dev server http://localhost:${PORT}  root=${ROOT}`));
