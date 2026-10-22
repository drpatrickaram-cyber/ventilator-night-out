// Data layer: one small API over two backends.
//  - Firebase (production): Firestore + anonymous auth
//  - Dev (local testing): WebSocket to tools/devserver.js  (enable with ?dev=1)
import { FIREBASE_CONFIG } from "./config.js";

const TS = { __ts: 1 };
const inc = (n) => ({ __inc: n });
const DEL = { __del: 1 };

let api = null;

export async function initDB() {
  if (api) return api;
  const dev = new URLSearchParams(location.search).has("dev") || sessionStorage.getItem("vno-dev") === "1";
  if (dev) sessionStorage.setItem("vno-dev", "1");
  api = dev ? await devBackend() : await firebaseBackend();
  api.TS = TS; api.inc = inc; api.DEL = DEL;
  api.offset = await measureOffset(api);
  api.now = () => Date.now() + api.offset;
  return api;
}

async function measureOffset(a) {
  let best = { rtt: Infinity, off: 0 };
  for (let i = 0; i < 3; i++) {
    try {
      const t0 = Date.now();
      const server = await a.serverNow();
      const t1 = Date.now();
      if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: server - (t0 + t1) / 2 };
    } catch (e) { console.warn("clock", e); }
  }
  return Math.round(best.off);
}

// ---------------------------------------------------------------- Firebase
async function firebaseBackend() {
  const F = await import("./vendor/firebase.js");
  const app = F.initializeApp(FIREBASE_CONFIG);
  const auth = F.getAuth(app);
  const fs = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });
  const uid = await new Promise((resolve, reject) => {
    const off = F.onAuthStateChanged(auth, (u) => {
      if (u) { off(); resolve(u.uid); }
    });
    F.signInAnonymously(auth).catch(reject);
  });

  const ref = (p) => F.doc(fs, p);
  const enc = (v) => {
    if (v === TS) return F.serverTimestamp();
    if (v === DEL) return F.deleteField();
    if (v && typeof v === "object" && "__inc" in v && Object.keys(v).length === 1) return F.increment(v.__inc);
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === "object" && v.constructor === Object) {
      const o = {}; for (const k in v) o[k] = enc(v[k]); return o;
    }
    return v;
  };
  const dec = (v) => {
    if (v instanceof F.Timestamp) return v.toMillis();
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = dec(v[k]); return o; }
    return v;
  };
  const snapData = (s) => (s.exists() ? dec(s.data({ serverTimestamps: "estimate" })) : null);
  const buildQuery = (path, o = {}) => {
    const parts = [F.collection(fs, path)];
    (o.where || []).forEach(([f, op, v]) => parts.push(F.where(f, op, v)));
    if (o.orderBy) parts.push(F.orderBy(o.orderBy[0], o.orderBy[1] || "asc"));
    if (o.limit) parts.push(F.limit(o.limit));
    return F.query(...parts);
  };

  return {
    backend: "firebase", uid, tsv: (ms) => F.Timestamp.fromMillis(ms),
    async get(p) { return snapData(await F.getDocFromServer(ref(p))); },
    set: (p, d, merge = false) => F.setDoc(ref(p), enc(d), { merge }),
    update: (p, patch) => F.updateDoc(ref(p), enc(patch)),
    create: (p, d) => F.setDoc(ref(p), enc(d)),
    remove: (p) => F.deleteDoc(ref(p)),
    onDoc: (p, cb, err) => F.onSnapshot(ref(p), (s) => cb(snapData(s)), err || ((e) => console.error(p, e))),
    onColl: (p, o, cb, err) => F.onSnapshot(buildQuery(p, o), (qs) => cb(qs.docs.map((d) => ({ id: d.id, ...snapData(d) }))), err || ((e) => console.error(p, e))),
    async tx(p, fn) {
      return F.runTransaction(fs, async (t) => {
        const s = await t.get(ref(p));
        const patch = fn(s.exists() ? dec(s.data()) : null);
        if (!patch) return false;
        if (s.exists()) t.update(ref(p), enc(patch)); else t.set(ref(p), enc(patch));
        return true;
      });
    },
    async batch(ops) {
      const b = F.writeBatch(fs);
      for (const o of ops) {
        if (o.op === "delete") b.delete(ref(o.path));
        else if (o.op === "update") b.update(ref(o.path), enc(o.data));
        else b.set(ref(o.path), enc(o.data), { merge: !!o.merge });
      }
      return b.commit();
    },
    async count(p, o) { const r = await F.getCountFromServer(buildQuery(p, o)); return r.data().count; },
    async list(p, o) {
      return new Promise((res, rej) => {
        const un = F.onSnapshot(buildQuery(p, o), (qs) => { un(); res(qs.docs.map((d) => ({ id: d.id, ...snapData(d) }))); }, rej);
      });
    },
    async serverNow() {
      const r = ref(`clock/${uid}`);
      await F.setDoc(r, { t: F.serverTimestamp() });
      const s = await F.getDocFromServer(r);
      return s.data().t.toMillis();
    },
  };
}

// ---------------------------------------------------------------- Dev (local)
async function devBackend() {
  let uid = localStorage.getItem("vno-dev-uid");
  if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 12); localStorage.setItem("vno-dev-uid", uid); }
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const subs = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.sub) { const cb = subs.get(m.sub); if (cb) cb(m.data); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error)) : p.res(m.data);
  };
  const call = (msg) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ ...msg, id, uid })); });
  const sub = (msg, cb) => {
    const id = ++seq; subs.set(id, cb);
    ws.send(JSON.stringify({ ...msg, id, uid, type: msg.type }));
    return () => { subs.delete(id); ws.send(JSON.stringify({ type: "unsub", id })); };
  };
  return {
    backend: "dev", uid, tsv: (ms) => ms,
    get: (path) => call({ type: "get", path }),
    set: (path, data, merge = false) => call({ type: "set", path, data, merge }),
    update: (path, data) => call({ type: "update", path, data }),
    create: (path, data) => call({ type: "create", path, data }),
    remove: (path) => call({ type: "delete", path }),
    onDoc: (path, cb) => sub({ type: "subdoc", path }, cb),
    onColl: (path, opts, cb) => sub({ type: "subcoll", path, opts }, cb),
    async tx(path, fn) {
      for (let i = 0; i < 10; i++) {
        const { data, ver } = await call({ type: "txget", path });
        const patch = fn(data);
        if (!patch) return false;
        const ok = await call({ type: "txcommit", path, ver, data: patch });
        if (ok) return true;
      }
      throw new Error("tx failed");
    },
    batch: (ops) => call({ type: "batch", ops }),
    count: (path, opts) => call({ type: "count", path, opts }),
    list: (path, opts) => call({ type: "list", path, opts }),
    serverNow: () => call({ type: "now" }),
  };
}
