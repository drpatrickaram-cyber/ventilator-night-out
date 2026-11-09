// Load test against the local dev server: N fake players join and answer every question.
//   node tools/sim.mjs [players=150] [base=http://localhost:8790]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const N = +(process.argv[2] || 150);
const BASE = (process.argv[3] || "http://localhost:8790").replace(/^http/, "ws") + "/ws";
const FIRST = ["สมชาย", "สมหญิง", "กิตติ", "วรรณา", "ปิยะ", "อรุณ", "ณัฐ", "ศิริ", "ธนา", "พิมพ์", "Alex", "Mina", "ภูมิ", "ชนิดา", "ก้อง"];
const LAST = ["ใจดี", "รักษา", "ศรีสุข", "วงศ์ทอง", "แสงดาว", "บุญมา", "Lee", "ทองคำ"];
const INST = ["รพ.พระมงกุฎเกล้า", "รพ.จุฬาลงกรณ์", "รพ.ศิริราช", "รพ.รามาธิบดี", "รพ.ราชวิถี", "รพ.นครพิงค์", "รพ.ขอนแก่น", "รพ.สงขลานครินทร์"];
const WRONG = ["PEEP", "FiO2", "8", "auto-trigger", "flow starvation", "ไม่ทราบ", "inspiratory hold", "10 mL/kg", "Ppeak - PEEP", "reverse trigger"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TS = { __ts: 1 };

function client(uid) {
  const ws = new WebSocket(BASE);
  let seq = 0; const pend = new Map(); const subs = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.sub) return subs.get(m.sub)?.(m.data);
    const p = pend.get(m.id); if (!p) return; pend.delete(m.id);
    m.error ? p.rej(new Error(m.error)) : p.res(m.data);
  });
  const ready = new Promise((r) => ws.on("open", r));
  const call = (msg) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ ...msg, id, uid })); });
  const sub = (msg, cb) => { const id = ++seq; subs.set(id, cb); ws.send(JSON.stringify({ ...msg, id, uid })); };
  return { ready, call, sub, close: () => ws.close() };
}

function variant(ans) {
  let s = ans;
  const r = Math.random();
  if (r < 0.3) s = s.toUpperCase();
  else if (r < 0.5) s = " " + s.replace(/ /g, "  ") + " ";
  else if (r < 0.65 && s.length >= 8) { const i = 2 + Math.floor(Math.random() * (s.length - 4)); s = s.slice(0, i) + s.slice(i + 1); } // typo
  return s;
}

const bankCache = new Map();
async function main() {
  const admin = client("sim-admin");
  await admin.ready;
  const players = [];
  for (let i = 0; i < N; i++) {
    const uid = "sim" + i.toString(36).padStart(4, "0");
    const c = client(uid); await c.ready;
    await c.call({ type: "set", path: `q_players/${uid}`, data: { name: `${pick(FIRST)} ${pick(LAST)} ${i + 1}`, inst: pick(INST), at: TS } });
    players.push({ uid, c, skill: Math.random() });
  }
  console.log(`${N} players joined`);
  const done = new Set();
  admin.sub({ type: "subdoc", path: "q_state/live" }, async (st) => {
    if (!st || st.phase !== "question" || done.has(st.qid + st.openedAt)) return;
    done.add(st.qid + st.openedAt);
    if (!bankCache.has(st.qid)) bankCache.set(st.qid, await admin.call({ type: "get", path: `q_bank/${st.qid}` }));
    const q = bankCache.get(st.qid) || {};
    const acc = q.accepted || [];
    console.log(`question ${st.no} (${st.qid}) open for ${st.secs}s — ${acc.length} accepted`);
    let sent = 0;
    await Promise.all(players.map(async (p) => {
      if (Math.random() < 0.12) return; // no answer
      const delay = 1200 + Math.random() * (st.secs * 1000 - 2500) * (1.2 - p.skill * 0.7);
      await sleep(Math.min(delay, st.secs * 1000 - 400));
      const right = acc.length && Math.random() < 0.35 + p.skill * 0.5;
      const text = right ? variant(pick(acc)) : pick(WRONG);
      try { await p.c.call({ type: "create", path: `q_answers/${st.qid}_${p.uid}`, data: { qid: st.qid, uid: p.uid, text, at: TS } }); sent++; } catch (e) { /* duplicate */ }
    }));
    console.log(`  sent ${sent} answers`);
  });
}
main();
