// Host console: question bank + import, live control, grouped judging, scoring, results, settings.
import { initDB } from "./db.js";
import {
  h, mount, $, P, DEFAULT_SECS, staffGate, toast, pageURL, qrSVG, prettyURL, norm, autoJudge, splitAccepted,
  points, remainingMs, fmtSec, fmtDate, nf, downloadCSV, downloadBlob, compressImage, parseTextImport,
} from "./core.js";

let db;
let state = null, config = {}, board = null;
let bank = [];
const imgCache = new Map();
const players = new Map();
const results = new Map();
let answers = [], answersQid = null, unsubAnswers = null;
let selectedQid = null, judgeOverride = null, judgeFilter = "all";
const panes = {};

const PHASE_LABEL = {
  lobby: "หน้ารอ", question: "กำลังรับคำตอบ", closed: "ปิดรับคำตอบแล้ว",
  reveal: "กำลังเฉลย", board: "ตารางคะแนน", final: "ประกาศผลรวม",
};
const newSession = () => Date.now().toString(36);
const newId = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const bankById = (id) => bank.find((q) => q.id === id);
const judgeQid = () => judgeOverride || state?.qid || null;
const busy = async (btn, fn) => {
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try { await fn(); } catch (e) { console.error(e); toast("ไม่สำเร็จ: " + (e.message || e), "err"); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
};

boot();
async function boot() {
  db = await initDB();
  await staffGate(db, "Audience Quiz · Host");
  for (const k of ["live", "bank", "results", "settings"]) panes[k] = $(`#pane-${k}`);
  setupTabs();
  renderHeaderLinks();
  buildLiveSkeleton();

  db.onDoc(P.config, (d) => { config = d || {}; renderSettings(); });
  db.onDoc(P.board, (d) => { board = d; if (!panes.results.hidden) renderResults(); });
  db.onColl(P.bank, {}, (rows) => {
    bank = rows.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(b.id));
    renderPicker(); renderControl(); renderJudge(); renderBank();
  });
  db.onColl(P.players, {}, (rows) => {
    players.clear(); rows.forEach((r) => players.set(r.id, r));
    scheduleCounts(); renderControl();
  });
  db.onColl(P.results, {}, (rows) => {
    results.clear(); rows.forEach((r) => { if (!r.id.startsWith("_")) results.set(r.id, r); });
    renderPicker(); renderJudge();
    if (!panes.results.hidden) renderResults();
  });
  db.onDoc(P.state, async (d) => {
    const prevQid = state?.qid;
    state = d;
    if (!d) {
      const fresh = await db.get(P.state).catch(() => null);
      if (!fresh) await db.set(P.state, { phase: "lobby", session: newSession(), round: 0 });
      return;
    }
    if (d.qid !== prevQid) judgeOverride = null;
    watchAnswers(judgeQid());
    renderPicker(); renderControl(); renderJudge();
  });
  setInterval(tick, 200);
}

// ---------------------------------------------------------------- tabs + header
function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (t) => {
    tabs.forEach((x) => { const on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; $(`#${x.getAttribute("aria-controls")}`).hidden = !on; });
    const k = t.id.replace("tab-", "");
    if (k === "results") renderResults();
    if (k === "bank") renderBank();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); select(n); }
    });
  });
  window.__selectTab = (k) => select($(`#tab-${k}`));
}
function renderHeaderLinks() {
  mount($("#hd-links"),
    h("a", { class: "btn btn-sm", href: pageURL("screen.html"), target: "_blank", rel: "noopener" }, "เปิดจอหลัก ↗"),
    h("a", { class: "btn btn-sm", href: pageURL("index.html"), target: "_blank", rel: "noopener" }, "หน้าผู้ชม ↗"));
}

// ---------------------------------------------------------------- answers + counters
function watchAnswers(qid) {
  if (qid === answersQid) return;
  unsubAnswers?.(); answers = []; answersQid = qid; unsubAnswers = null;
  if (!qid) return;
  unsubAnswers = db.onColl(P.answers, { where: [["qid", "==", qid]] }, (rows) => {
    answers = rows; renderJudge(); scheduleCounts(); updateLiveCounts();
  });
}
let countTimer = null, lastCounts = "";
function scheduleCounts() {
  if (countTimer) return;
  countTimer = setTimeout(async () => {
    countTimer = null;
    if (!state) return;
    // counters live in their own doc so the phones (which watch q_state) are not woken every second
    const next = { players: players.size, qid: state.qid || null, answered: state.qid && answersQid === state.qid ? answers.length : 0 };
    if (JSON.stringify(next) !== lastCounts) { lastCounts = JSON.stringify(next); await db.set(P.counts, next).catch(() => { lastCounts = ""; }); }
  }, 700);
}

let closing = false;
function tick() {
  if (!state || !db) return;
  if (state.phase === "question") {
    const ms = remainingMs(state, db.now());
    const c = document.getElementById("h-clock");
    if (c) c.textContent = `${Math.ceil(ms / 1000)} วิ`;
    // close 1.5 s after the buzzer so answers sent at the last moment still land (rules allow +2 s)
    const raw = state.openedAt + (state.secs || DEFAULT_SECS) * 1000 - db.now();
    if (state.openedAt && raw <= -1500 && !closing) { closing = true; closeQuestion().finally(() => { closing = false; }); }
  }
}
function updateLiveCounts() {
  const a = document.getElementById("h-answered"); if (a) a.textContent = nf(answers.length);
}

// ---------------------------------------------------------------- game actions
async function openQuestion(qid) {
  const q = bankById(qid);
  if (!q) return;
  if (state?.phase === "question") { toast("ปิดรับคำตอบข้อปัจจุบันก่อน", "err"); return; }
  if (!(q.accepted || []).length && !confirm("ข้อนี้ยังไม่มีคำตอบที่ยอมรับ ระบบจะตรวจอัตโนมัติไม่ได้ (ต้องกดตัดสินเอง) เปิดเลยไหม?")) return;
  const prev = results.get(qid);
  if (q.usedNo || prev?.scores) {
    if (!confirm(`ข้อนี้เคยเปิดแล้ว (ข้อ ${q.usedNo || prev?.no}) ต้องการลบคำตอบเดิมแล้วเปิดใหม่ไหม?`)) return;
    await resetQuestion(qid, { keepMarks: true });
  }
  const no = (state?.round || 0) + 1;
  const secs = q.secs || config.defaultSecs || DEFAULT_SECS;
  const img = q.hasImg ? await getImg(qid) : null;
  await db.batch([
    { op: "set", path: P.pub, data: { qid, no, label: q.label || "", text: q.text || "", img: img || null, secs } },
    { op: "update", path: P.state, data: { phase: "question", qid, no, round: no, openedAt: db.TS, secs, finalStep: 0, reveal: db.DEL } },
    { op: "set", path: P.counts, data: { players: players.size, qid, answered: 0 } },
    { op: "update", path: `${P.bank}/${qid}`, data: { usedNo: no } },
  ]);
  selectedQid = null;
}
async function closeQuestion() {
  if (state?.phase !== "question") return;
  const { qid, openedAt, secs, no } = state;
  await db.update(P.state, { phase: "closed", closedAt: db.TS });
  await db.set(`${P.results}/${qid}`, { qid, openedAt, secs, no }, true);
}
async function addTime(n) {
  if (state?.phase !== "question") return;
  await db.batch([
    { op: "update", path: P.state, data: { secs: (state.secs || DEFAULT_SECS) + n } },
    { op: "update", path: P.pub, data: { secs: (state.secs || DEFAULT_SECS) + n } },
  ]);
}
async function reveal() {
  const qid = state?.qid;
  if (!qid) return;
  if (state.phase === "question") await closeQuestion();
  await finalize(qid, { publish: true });
}
const setPhase = (phase, extra = {}) => db.update(P.state, { phase, ...extra });
async function toLobby() { if (state?.phase === "question") await closeQuestion(); await setPhase("lobby"); }
async function showBoard() { if (state?.phase === "question") await closeQuestion(); await rebuildBoard(state?.reveal?.qid || board?.qid || null); await setPhase("board"); }
async function finalStep(n) { if (state?.phase === "question") await closeQuestion(); if (n === 0) await rebuildBoard(board?.qid || null); await setPhase("final", { finalStep: n }); }

function verdictOf(text, q, marks) {
  const key = norm(text) || "_";
  if (key in marks) return !!marks[key];
  return key !== "_" && autoJudge(text, q?.accepted);
}

async function finalize(qid, { publish = false } = {}) {
  const q = bankById(qid) || {};
  const r0 = results.get(qid) || {};
  const marks = r0.marks || {};
  const live = state?.qid === qid;
  const openedAt = (live && state.openedAt) || r0.openedAt;
  const secs = (live && state.secs) || r0.secs || q.secs || DEFAULT_SECS;
  const no = (live && state.no) || r0.no || q.usedNo || 0;
  if (!openedAt) { toast("ไม่พบเวลาเปิดคำถามของข้อนี้", "err"); return; }
  const list = answersQid === qid ? answers : await db.list(P.answers, { where: [["qid", "==", qid]] });
  const scores = {}, correct = [];
  for (const a of list) {
    if (!verdictOf(a.text, q, marks)) continue;
    const ms = Math.max(0, a.at - openedAt);
    scores[a.uid] = [points(ms, secs), ms];
    correct.push({ uid: a.uid, ms });
  }
  correct.sort((a, b) => a.ms - b.ms);
  const taken = new Set();
  if (config.onePrize !== false) for (const [id, r] of results) if (id !== qid && r.winner?.uid) taken.add(r.winner.uid);
  let w = null;
  if (r0.winnerPick && scores[r0.winnerPick]) w = { uid: r0.winnerPick, ms: scores[r0.winnerPick][1] };
  else w = correct.find((c) => !taken.has(c.uid)) || null;
  const p = w && players.get(w.uid);
  const winner = w ? { uid: w.uid, ms: w.ms, name: p?.name || "ไม่ทราบชื่อ", inst: p?.inst || "" } : null;
  const answerText = q.display || (q.accepted || [])[0] || "";
  const doc = { qid, no, label: q.label || "", text: q.text || "", secs, openedAt, scores, answered: list.length, correctN: correct.length, winner, answerText, marks, finalizedAt: db.TS };
  if (r0.winnerPick) doc.winnerPick = r0.winnerPick;
  await db.set(`${P.results}/${qid}`, doc);
  results.set(qid, { ...doc, id: qid, finalizedAt: Date.now() });
  await rebuildBoard(qid);
  if (publish || state?.reveal?.qid === qid) {
    await db.update(P.state, { reveal: { qid, answer: answerText, winner, correctN: correct.length, answered: list.length }, ...(publish ? { phase: "reveal" } : {}) });
  }
}

function leaderboard() {
  const tot = new Map();
  const finals = [...results.values()].filter((r) => r.scores);
  for (const r of finals) for (const [uid, [pts, ms]] of Object.entries(r.scores)) {
    const t = tot.get(uid) || { uid, score: 0, correct: 0, ms: 0 };
    t.score += pts; t.correct += 1; t.ms += ms; tot.set(uid, t);
  }
  const all = [...players.keys()].map((uid) => tot.get(uid) || { uid, score: 0, correct: 0, ms: 0 });
  for (const [uid, t] of tot) if (!players.has(uid)) all.push(t);
  all.sort((a, b) => b.score - a.score || a.ms - b.ms);
  let rank = 0, prev = null;
  all.forEach((t, i) => {
    if (!prev || t.score !== prev.score || t.ms !== prev.ms) rank = i + 1;
    prev = t; t.rank = rank;
    const p = players.get(t.uid); t.name = p?.name || "ไม่ทราบชื่อ"; t.inst = p?.inst || "";
  });
  return { all, finals };
}
async function rebuildBoard(lastQid) {
  const { all, finals } = leaderboard();
  const ranks = {};
  for (const t of all) ranks[t.uid] = [t.score, t.rank, results.get(lastQid)?.scores?.[t.uid]?.[0] || 0, t.correct];
  const top = all.filter((t) => t.score > 0).slice(0, 10).map(({ uid, name, inst, score, correct, ms }) => ({ uid, name, inst, score, correct, ms }));
  const winners = finals.filter((r) => r.winner).sort((a, b) => a.no - b.no)
    .map((r) => ({ no: r.no, label: r.label || "", qid: r.qid, uid: r.winner.uid, name: r.winner.name, inst: r.winner.inst, ms: r.winner.ms }));
  await db.set(P.board, { v: Date.now(), qid: lastQid || null, done: finals.length, n: all.length, top, ranks, winners });
}

async function deleteDocs(coll, rows) {
  for (let i = 0; i < rows.length; i += 400) await db.batch(rows.slice(i, i + 400).map((r) => ({ op: "delete", path: `${coll}/${r.id}` })));
}
async function resetQuestion(qid, { keepMarks = false } = {}) {
  const rows = await db.list(P.answers, { where: [["qid", "==", qid]] });
  await deleteDocs(P.answers, rows);
  const marks = results.get(qid)?.marks;
  if (keepMarks && marks) await db.set(`${P.results}/${qid}`, { marks });
  else await db.remove(`${P.results}/${qid}`);
  results.delete(qid);
  if (bankById(qid)?.usedNo) await db.update(`${P.bank}/${qid}`, { usedNo: db.DEL });
  await rebuildBoard(board?.qid === qid ? null : board?.qid || null);
}
async function resetGame() {
  await deleteDocs(P.answers, await db.list(P.answers));
  await deleteDocs(P.players, await db.list(P.players));
  await deleteDocs(P.results, await db.list(P.results));
  const used = bank.filter((q) => q.usedNo);
  if (used.length) await db.batch(used.map((q) => ({ op: "update", path: `${P.bank}/${q.id}`, data: { usedNo: db.DEL } })));
  await db.set(P.board, { v: Date.now(), qid: null, done: 0, n: 0, top: [], ranks: {}, winners: [] });
  await db.set(P.pub, { qid: null });
  await db.set(P.counts, { players: 0, qid: null, answered: 0 });
  await db.set(P.state, { phase: "lobby", session: newSession(), round: 0 });
  results.clear(); lastCounts = ""; selectedQid = null; judgeOverride = null;
}

// ---------------------------------------------------------------- images
async function getImg(id) {
  if (imgCache.has(id)) return imgCache.get(id);
  const p = db.get(`${P.bankImg}/${id}`).then((d) => d?.img || null).catch(() => null);
  imgCache.set(id, p);
  return p;
}
function thumb(q, cls = "thumb") {
  if (!q.hasImg) return h("span", { class: `${cls} none`, "aria-hidden": "true" }, "ข้อความ");
  const im = h("img", { class: cls, alt: "" });
  getImg(q.id).then((src) => { if (src) im.src = src; });
  return im;
}

// ---------------------------------------------------------------- LIVE pane
let liveEls = {};
function buildLiveSkeleton() {
  liveEls = {
    picker: h("div", { class: "lv-list" }),
    control: h("div", { class: "lv-control" }),
    judge: h("div", { class: "lv-judge-body" }),
    judgeHead: h("div", { class: "lv-judge-head" }),
  };
  mount(panes.live, h("div", { class: "lv" },
    h("aside", { class: "card lv-picker", "aria-labelledby": "pk-h" },
      h("div", { class: "card-head" }, h("h2", { id: "pk-h" }, "เลือกโจทย์"), h("button", { class: "btn btn-sm btn-ghost", onclick: () => window.__selectTab("bank") }, "จัดการคลัง")),
      liveEls.picker),
    h("section", { class: "lv-center" }, liveEls.control),
    h("section", { class: "card lv-judge", "aria-label": "ตรวจคำตอบ" }, liveEls.judgeHead, liveEls.judge)));
}

function renderPicker() {
  if (!liveEls.picker) return;
  if (!bank.length) {
    mount(liveEls.picker, h("div", { class: "empty" }, h("p", {}, "ยังไม่มีโจทย์"), h("button", { class: "btn btn-primary", onclick: () => window.__selectTab("bank") }, "ไปเพิ่มโจทย์")));
    return;
  }
  mount(liveEls.picker, bank.map((q, i) => {
    const r = results.get(q.id);
    const current = state?.qid === q.id && ["question", "closed", "reveal"].includes(state.phase);
    const status = current ? h("span", { class: "tag tag-live" }, PHASE_LABEL[state.phase])
      : q.usedNo ? h("span", { class: "tag tag-done" }, `ใช้แล้ว · ข้อ ${q.usedNo}${r?.answered != null ? ` · ${r.answered} คน` : ""}`)
      : !(q.accepted || []).length ? h("span", { class: "tag tag-warn" }, "ยังไม่มีคำตอบ") : null;
    return h("button", {
      type: "button", class: `pk${selectedQid === q.id ? " sel" : ""}${current ? " cur" : ""}${q.usedNo && !current ? " used" : ""}`,
      "aria-pressed": String(selectedQid === q.id),
      onclick: () => { selectedQid = q.id; renderPicker(); renderControl(); },
    },
      h("span", { class: "pk-n num" }, String(i + 1)),
      thumb(q, "pk-thumb"),
      h("span", { class: "pk-body" },
        q.label ? h("span", { class: "pk-label" }, q.label) : null,
        h("span", { class: "pk-text" }, q.text || "(โจทย์เป็นภาพ)"),
        status));
  }));
}

function renderControl() {
  const el = liveEls.control;
  if (!el) return;
  const phase = state?.phase || "lobby";
  const curQ = state?.qid ? bankById(state.qid) : null;
  const active = ["question", "closed", "reveal"].includes(phase) && curQ;

  const banner = h("div", { class: `phase phase-${phase}` },
    h("span", { class: "phase-dot", "aria-hidden": "true" }),
    h("span", {}, "จอตอนนี้: ", h("strong", {}, PHASE_LABEL[phase] + (phase === "final" ? ` · ขั้น ${(state.finalStep || 0) + 1}/4` : ""))),
    h("span", { class: "phase-meta" }, "ผู้ร่วมเล่น ", h("strong", { class: "num" }, nf(players.size)), " คน"));

  let current = null;
  if (active) {
    const actions = [];
    if (phase === "question") actions.push(
      h("button", { class: "btn", onclick: (e) => busy(e.currentTarget, () => addTime(10)) }, "+10 วิ"),
      h("button", { class: "btn btn-primary", onclick: (e) => busy(e.currentTarget, closeQuestion) }, "ปิดรับคำตอบเลย"));
    if (phase === "closed") actions.push(h("button", { class: "btn btn-amber btn-lg", onclick: (e) => busy(e.currentTarget, reveal) }, "เฉลยบนจอ"));
    if (phase === "reveal") actions.push(
      h("button", { class: "btn btn-primary btn-lg", onclick: (e) => busy(e.currentTarget, showBoard) }, "แสดงตารางคะแนน"),
      h("button", { class: "btn btn-lg", onclick: (e) => busy(e.currentTarget, toLobby) }, "กลับหน้ารอ"));
    current = h("div", { class: "card cur-card" },
      h("div", { class: "cur-top" },
        h("span", { class: "cur-no" }, `ข้อ ${state.no}${curQ.label ? " · " + curQ.label : ""}`),
        phase === "question" ? h("span", { class: "cur-clock num", id: "h-clock" }, "") : null),
      h("p", { class: "cur-text" }, curQ.text || "(โจทย์เป็นภาพ)"),
      h("div", { class: "cur-stats" },
        h("span", {}, "ส่งแล้ว ", h("strong", { class: "num", id: "h-answered" }, nf(answers.length)), ` / ${nf(players.size)}`),
        h("span", {}, "คำตอบที่ยอมรับ: ", h("strong", {}, (curQ.accepted || []).join(", ") || "—"))),
      phase === "closed" ? h("p", { class: "hint" }, "ตรวจกลุ่มคำตอบทางขวาให้เรียบร้อย แล้วกดเฉลย") : null,
      phase === "reveal" && state.reveal ? h("p", { class: "hint" }, state.reveal.winner ? `เร็วที่สุด: ${state.reveal.winner.name} (${state.reveal.winner.inst}) ${fmtSec(state.reveal.winner.ms)} วิ` : "ไม่มีผู้ตอบถูก") : null,
      h("div", { class: "actions" }, actions));
  }

  let preview = null;
  const sel = selectedQid && bankById(selectedQid);
  if (sel && phase !== "question") {
    const idx = bank.indexOf(sel) + 1;
    preview = h("div", { class: "card prev-card" },
      h("div", { class: "card-head" }, h("h2", {}, `โจทย์ที่เลือก · #${idx}${sel.label ? " · " + sel.label : ""}`),
        h("button", { class: "btn btn-sm btn-ghost", onclick: () => openEditor(sel.id) }, "แก้ไข")),
      sel.hasImg ? thumb(sel, "prev-img") : null,
      sel.text ? h("p", { class: "prev-text" }, sel.text) : null,
      h("div", { class: "chips" }, (sel.accepted || []).length ? sel.accepted.map((a) => h("span", { class: "chip" }, a)) : h("span", { class: "tag tag-warn" }, "ยังไม่มีคำตอบที่ยอมรับ")),
      h("p", { class: "hint" }, `เวลา ${sel.secs || config.defaultSecs || DEFAULT_SECS} วินาที${sel.usedNo ? ` · เคยเปิดเป็นข้อ ${sel.usedNo}` : ""}`),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-amber btn-lg", onclick: (e) => busy(e.currentTarget, () => openQuestion(sel.id)) }, sel.usedNo ? "เปิดข้อนี้ใหม่" : `เปิดคำถาม (ข้อ ${(state?.round || 0) + 1})`)));
  } else if (!active && phase !== "question") {
    preview = h("div", { class: "card prev-card empty" }, h("p", {}, "เลือกโจทย์จากรายการทางซ้าย ตามข้อที่ทีมบนเวทีเลือก แล้วกด “เปิดคำถาม”"));
  }

  const screenCtl = h("div", { class: "card screen-ctl" },
    h("div", { class: "card-head" }, h("h2", {}, "สลับจอหลัก")),
    h("div", { class: "actions wrap" },
      h("button", { class: "btn", "aria-pressed": String(phase === "lobby"), onclick: (e) => busy(e.currentTarget, toLobby) }, "หน้ารอ + QR"),
      h("button", { class: "btn", "aria-pressed": String(phase === "board"), onclick: (e) => busy(e.currentTarget, showBoard) }, "ตารางคะแนน")),
    h("p", { class: "sub" }, "ประกาศผลตอนจบ (กดตามลำดับ)"),
    h("div", { class: "actions wrap" },
      ["รางวัลรายข้อ", "อันดับ 3", "อันดับ 2", "อันดับ 1"].map((t, n) =>
        h("button", { class: `btn${phase === "final" && (state.finalStep || 0) === n ? " btn-primary" : ""}`, onclick: (e) => busy(e.currentTarget, () => finalStep(n)) }, t))));

  mount(el, banner, current, preview, screenCtl);
}

// --- judging
function groupsFor(qid) {
  const q = bankById(qid);
  const marks = results.get(qid)?.marks || {};
  const map = new Map();
  for (const a of answers) {
    const key = norm(a.text) || "_";
    let g = map.get(key);
    if (!g) { g = { key, texts: new Map(), count: 0, first: Infinity }; map.set(key, g); }
    g.count++; g.texts.set(a.text, (g.texts.get(a.text) || 0) + 1);
    if (a.at < g.first) g.first = a.at;
  }
  const out = [...map.values()].map((g) => {
    g.sample = [...g.texts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    g.marked = g.key in marks;
    g.correct = verdictOf(g.sample, q, marks);
    return g;
  });
  return out.sort((a, b) => b.count - a.count || a.first - b.first);
}

let refinalizeTimer = null;
async function setMark(qid, key, val) {
  await db.set(`${P.results}/${qid}`, { marks: { [key]: val } }, true);
  if (results.get(qid)?.finalizedAt) {
    clearTimeout(refinalizeTimer);
    refinalizeTimer = setTimeout(() => finalize(qid).then(() => toast("อัปเดตคะแนนแล้ว", "ok")), 700);
  }
}
async function pickWinner(qid, uid) {
  await db.set(`${P.results}/${qid}`, { winnerPick: uid }, true);
  const r = results.get(qid); if (r) r.winnerPick = uid;
  if (r?.finalizedAt) { await finalize(qid); toast("เปลี่ยนผู้ได้รางวัลแล้ว", "ok"); }
}

function renderJudge() {
  if (!liveEls.judge) return;
  const qid = judgeQid();
  const q = qid && bankById(qid);
  if (!q) {
    mount(liveEls.judgeHead, h("div", { class: "card-head" }, h("h2", {}, "ตรวจคำตอบ")));
    mount(liveEls.judge, h("p", { class: "empty" }, "คำตอบของผู้ชมจะขึ้นที่นี่เมื่อเปิดคำถาม"));
    return;
  }
  const r = results.get(qid) || {};
  const marks = r.marks || {};
  const groups = groupsFor(qid);
  const nCorrect = groups.filter((g) => g.correct).reduce((s, g) => s + g.count, 0);

  // header keeps its input element across re-renders
  if (liveEls.judgeHead.dataset.qid !== qid) {
    liveEls.judgeHead.dataset.qid = qid;
    const add = h("input", { class: "inp", placeholder: "เพิ่มคำตอบที่ยอมรับ แล้วกด Enter", "aria-label": "เพิ่มคำตอบที่ยอมรับ" });
    const form = h("form", { class: "add-acc", onsubmit: async (e) => {
      e.preventDefault();
      const v = add.value.trim(); if (!v) return;
      const cur = bankById(qid)?.accepted || [];
      await db.update(`${P.bank}/${qid}`, { accepted: [...cur, ...splitAccepted(v)] });
      add.value = "";
      if (results.get(qid)?.finalizedAt) await finalize(qid);
    } }, add, h("button", { class: "btn btn-sm", type: "submit" }, "เพิ่ม"));
    mount(liveEls.judgeHead,
      h("div", { class: "card-head" }, h("h2", { id: "jd-title" }, ""), judgeOverride ? h("button", { class: "btn btn-sm btn-ghost", onclick: () => { judgeOverride = null; liveEls.judgeHead.dataset.qid = ""; watchAnswers(judgeQid()); renderJudge(); } }, "กลับข้อปัจจุบัน") : null),
      h("div", { class: "chips", id: "jd-acc" }), form,
      h("div", { class: "seg", role: "group", "aria-label": "กรองคำตอบ", id: "jd-seg" }));
  }
  $("#jd-title").textContent = `ตรวจคำตอบ · ข้อ ${r.no || q.usedNo || "?"}${q.label ? " · " + q.label : ""}`;
  mount($("#jd-acc"), (q.accepted || []).length ? q.accepted.map((a) => h("span", { class: "chip" }, a)) : h("span", { class: "tag tag-warn" }, "ยังไม่มีคำตอบที่ยอมรับ"));
  mount($("#jd-seg"), [["all", `ทั้งหมด ${answers.length}`], ["ok", `ถูก ${nCorrect}`], ["bad", `ผิด ${answers.length - nCorrect}`]].map(([k, t]) =>
    h("button", { type: "button", "aria-pressed": String(judgeFilter === k), onclick: () => { judgeFilter = k; renderJudge(); } }, t)));

  const shown = groups.filter((g) => judgeFilter === "all" || (judgeFilter === "ok" ? g.correct : !g.correct));
  const list = h("ul", { class: "groups" }, shown.map((g) => h("li", { class: `grp ${g.correct ? "ok" : "bad"}` },
    h("button", {
      type: "button", class: "verdict", "aria-pressed": String(g.correct),
      "aria-label": `${g.sample}: ${g.correct ? "ถูก" : "ผิด"} กดเพื่อเปลี่ยน`,
      onclick: (e) => busy(e.currentTarget, () => setMark(qid, g.key, !g.correct)),
    }, g.correct ? "✓ ถูก" : "✗ ผิด"),
    h("span", { class: "grp-text" }, g.sample, g.texts.size > 1 ? h("small", {}, ` (+${g.texts.size - 1} แบบ)`) : null),
    h("span", { class: "grp-n num" }, `×${g.count}`),
    h("span", { class: "grp-src" }, g.marked ? "ตัดสินเอง" : "อัตโนมัติ"),
    g.marked ? h("button", { type: "button", class: "btn btn-sm btn-ghost", title: "กลับไปใช้ผลอัตโนมัติ", onclick: (e) => busy(e.currentTarget, () => setMark(qid, g.key, db.DEL)) }, "คืนค่า") : null)));

  // fastest correct (winner candidates)
  const openedAt = (state?.qid === qid && state.openedAt) || r.openedAt;
  const fast = answers.filter((a) => verdictOf(a.text, q, marks)).sort((a, b) => a.at - b.at).slice(0, 6);
  const taken = new Set();
  if (config.onePrize !== false) for (const [id, rr] of results) if (id !== qid && rr.winner?.uid) taken.add(rr.winner.uid);
  const curWinner = r.winner?.uid;
  const fastBox = fast.length && openedAt ? h("div", { class: "fast" },
    h("h3", {}, "ตอบถูกเร็วที่สุด"),
    h("ol", {}, fast.map((a) => {
      const p = players.get(a.uid);
      return h("li", { class: curWinner === a.uid ? "win" : "" },
        h("span", { class: "num" }, `${fmtSec(a.at - openedAt)} วิ`),
        h("span", { class: "fast-name" }, p?.name || "?", h("small", {}, p?.inst || "")),
        taken.has(a.uid) ? h("span", { class: "tag" }, "ได้รางวัลข้ออื่นแล้ว")
          : curWinner === a.uid ? h("span", { class: "tag tag-done" }, "★ ผู้ได้รางวัล")
          : r.finalizedAt ? h("button", { class: "btn btn-sm", onclick: (e) => busy(e.currentTarget, () => pickWinner(qid, a.uid)) }, "ให้รางวัล") : null);
    }))) : null;

  const tools = h("div", { class: "jd-tools" },
    h("button", { class: "btn btn-sm btn-danger", onclick: (e) => { if (confirm("ลบคำตอบทั้งหมดของข้อนี้ และคืนสถานะเป็นยังไม่ใช้?")) busy(e.currentTarget, () => resetQuestion(qid)); } }, "ล้างคำตอบข้อนี้"));

  mount(liveEls.judge, answers.length ? list : h("p", { class: "empty" }, "ยังไม่มีคำตอบ"), fastBox, tools);
}

// ---------------------------------------------------------------- BANK pane
function renderBank() {
  const el = panes.bank;
  if (!el || el.hidden) return;
  const fileIn = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: (e) => importImages([...e.target.files]).finally(() => { e.target.value = ""; }) });
  const jsonIn = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: (e) => importJSON(e.target.files[0]).finally(() => { e.target.value = ""; }) });
  const noAns = bank.filter((q) => !(q.accepted || []).length).length;
  const drop = h("div", { class: "bank", tabindex: "-1" },
    h("div", { class: "bank-bar" },
      h("div", {}, h("h2", {}, "คลังโจทย์"), h("p", { class: "sub" }, `${bank.length} ข้อ${noAns ? ` · ${noAns} ข้อยังไม่มีคำตอบที่ยอมรับ` : ""}`)),
      h("div", { class: "actions wrap" },
        h("button", { class: "btn btn-primary", onclick: () => openEditor(null) }, "+ เพิ่มโจทย์"),
        h("button", { class: "btn", onclick: openTextImport }, "นำเข้าจากข้อความ"),
        h("button", { class: "btn", onclick: () => fileIn.click() }, "นำเข้าภาพ"),
        h("button", { class: "btn", onclick: () => jsonIn.click() }, "นำเข้าไฟล์สำรอง"),
        h("button", { class: "btn", onclick: (e) => busy(e.currentTarget, exportJSON), disabled: !bank.length }, "ดาวน์โหลดไฟล์สำรอง"),
        fileIn, jsonIn)),
    h("p", { class: "drop-hint" }, "ลากไฟล์ภาพมาวางในหน้านี้ได้ — 1 ภาพ = 1 ข้อ (เรียงตามชื่อไฟล์) · ในหน้าต่างแก้ไขกด Ctrl/⌘+V เพื่อวางภาพจากคลิปบอร์ด"),
    bank.length ? h("ol", { class: "bank-list" }, bank.map((q, i) => h("li", { class: "bq" },
      h("span", { class: "bq-n num" }, String(i + 1)),
      thumb(q, "bq-thumb"),
      h("div", { class: "bq-body" },
        h("div", { class: "bq-meta" }, q.label ? h("span", { class: "tag" }, q.label) : null, h("span", { class: "sub" }, `${q.secs || config.defaultSecs || DEFAULT_SECS} วิ`), q.usedNo ? h("span", { class: "tag tag-done" }, `ใช้แล้ว · ข้อ ${q.usedNo}`) : null),
        h("p", { class: "bq-text" }, q.text || h("em", {}, "(โจทย์เป็นภาพ ไม่มีข้อความ)")),
        h("div", { class: "chips" }, (q.accepted || []).length ? q.accepted.map((a) => h("span", { class: "chip" }, a)) : h("span", { class: "tag tag-warn" }, "ยังไม่มีคำตอบที่ยอมรับ"))),
      h("div", { class: "bq-act" },
        h("button", { class: "btn btn-sm btn-ghost", "aria-label": `เลื่อนข้อ ${i + 1} ขึ้น`, disabled: i === 0, onclick: (e) => busy(e.currentTarget, () => move(i, -1)) }, "↑"),
        h("button", { class: "btn btn-sm btn-ghost", "aria-label": `เลื่อนข้อ ${i + 1} ลง`, disabled: i === bank.length - 1, onclick: (e) => busy(e.currentTarget, () => move(i, 1)) }, "↓"),
        h("button", { class: "btn btn-sm", onclick: () => openEditor(q.id) }, "แก้ไข"),
        h("button", { class: "btn btn-sm btn-danger", onclick: (e) => { if (confirm(`ลบโจทย์ #${i + 1}?`)) busy(e.currentTarget, () => removeQuestion(q.id)); } }, "ลบ")))))
      : h("div", { class: "empty big" }, h("p", {}, "ยังไม่มีโจทย์ เริ่มจาก “+ เพิ่มโจทย์” “นำเข้าจากข้อความ” หรือลากภาพมาวาง")));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", (e) => { if (e.target === drop) drop.classList.remove("over"); });
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const files = [...e.dataTransfer.files];
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const json = files.find((f) => f.name.endsWith(".json"));
    if (imgs.length) importImages(imgs); else if (json) importJSON(json);
  });
  mount(el, drop);
}

const nextOrder = () => (bank.length ? Math.max(...bank.map((q) => q.order || 0)) + 1 : 1);
async function move(i, d) {
  const a = bank[i], b = bank[i + d];
  if (!a || !b) return;
  const oa = a.order ?? i + 1, ob = b.order ?? i + d + 1;
  await db.batch([
    { op: "update", path: `${P.bank}/${a.id}`, data: { order: ob === oa ? oa + d : ob } },
    { op: "update", path: `${P.bank}/${b.id}`, data: { order: oa } },
  ]);
}
async function removeQuestion(id) {
  await db.batch([{ op: "delete", path: `${P.bank}/${id}` }, { op: "delete", path: `${P.bankImg}/${id}` }]);
  imgCache.delete(id);
  if (selectedQid === id) selectedQid = null;
}
async function saveQuestion(id, data, img) {
  const isNew = !id;
  id = id || newId();
  const ops = [];
  const doc = { ...data };
  if (img === null) { doc.hasImg = false; ops.push({ op: "delete", path: `${P.bankImg}/${id}` }); imgCache.delete(id); }
  else if (typeof img === "string") { doc.hasImg = true; ops.push({ op: "set", path: `${P.bankImg}/${id}`, data: { img } }); imgCache.set(id, Promise.resolve(img)); }
  if (isNew) { doc.order = nextOrder(); doc.createdAt = db.TS; ops.unshift({ op: "set", path: `${P.bank}/${id}`, data: { hasImg: false, ...doc } }); }
  else ops.unshift({ op: "update", path: `${P.bank}/${id}`, data: doc });
  await db.batch(ops);
  return id;
}

async function importImages(files) {
  if (!files.length) return;
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  toast(`กำลังนำเข้า ${files.length} ภาพ…`);
  let order = nextOrder(), ok = 0;
  for (const f of files) {
    try {
      const { data } = await compressImage(f);
      const id = newId();
      await db.batch([
        { op: "set", path: `${P.bank}/${id}`, data: { text: "", accepted: [], display: "", label: f.name.replace(/\.[^.]+$/, ""), secs: config.defaultSecs || DEFAULT_SECS, hasImg: true, order: order++, createdAt: db.TS } },
        { op: "set", path: `${P.bankImg}/${id}`, data: { img: data } },
      ]);
      imgCache.set(id, Promise.resolve(data)); ok++;
    } catch (e) { toast(`${f.name}: ${e.message}`, "err"); }
  }
  toast(`นำเข้าแล้ว ${ok} ข้อ · อย่าลืมใส่คำตอบที่ยอมรับ`, "ok");
}

async function exportJSON() {
  const questions = [];
  for (const q of bank) questions.push({ label: q.label || "", text: q.text || "", accepted: q.accepted || [], display: q.display || "", secs: q.secs || null, img: q.hasImg ? await getImg(q.id) : null });
  downloadBlob(`audience-quiz-bank-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify({ app: "audience-quiz", version: 1, questions }, null, 1)], { type: "application/json" }));
}
async function importJSON(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast("ไฟล์ไม่ใช่ JSON ที่ถูกต้อง", "err"); return; }
  const qs = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(qs) || !qs.length) { toast("ไม่พบโจทย์ในไฟล์", "err"); return; }
  if (!confirm(`นำเข้า ${qs.length} ข้อ ต่อท้ายคลังเดิม?`)) return;
  let order = nextOrder();
  for (const q of qs) {
    const id = newId();
    const ops = [{ op: "set", path: `${P.bank}/${id}`, data: { label: String(q.label || ""), text: String(q.text || ""), accepted: Array.isArray(q.accepted) ? q.accepted.map(String) : splitAccepted(q.accepted), display: String(q.display || ""), secs: +q.secs || config.defaultSecs || DEFAULT_SECS, hasImg: !!q.img, order: order++, createdAt: db.TS } }];
    if (q.img) ops.push({ op: "set", path: `${P.bankImg}/${id}`, data: { img: q.img } });
    await db.batch(ops);
  }
  toast(`นำเข้าแล้ว ${qs.length} ข้อ`, "ok");
}

// --- dialogs
function dialog(title, body, footer) {
  const dlg = h("dialog", { class: "dlg", "aria-labelledby": "dlg-t" },
    h("div", { class: "dlg-head" }, h("h2", { id: "dlg-t" }, title), h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": "ปิด", onclick: () => dlg.close() }, "ปิด")),
    h("div", { class: "dlg-body" }, body),
    h("div", { class: "dlg-foot" }, footer));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

async function openEditor(id) {
  const q = id ? bankById(id) : null;
  let img = undefined; // undefined = unchanged, null = removed, string = new
  const curImg = q?.hasImg ? await getImg(id) : null;
  const label = h("input", { id: "ed-label", class: "inp", value: q?.label || "", placeholder: "เช่น Waveform 20" });
  const text = h("textarea", { id: "ed-text", class: "inp", rows: "4", placeholder: "พิมพ์โจทย์ (เว้นว่างได้ถ้าโจทย์เป็นภาพ)" }, q?.text || "");
  const acc = h("textarea", { id: "ed-acc", class: "inp", rows: "4", placeholder: "บรรทัดละ 1 คำตอบ เช่น\nPEEP\npositive end-expiratory pressure" }, (q?.accepted || []).join("\n"));
  const disp = h("input", { id: "ed-disp", class: "inp", value: q?.display || "", placeholder: "ถ้าว่าง จะใช้คำตอบแรก" });
  const secs = h("input", { id: "ed-secs", class: "inp", type: "number", min: "5", max: "300", value: String(q?.secs || config.defaultSecs || DEFAULT_SECS) });
  const imgBox = h("div", { class: "ed-img" });
  const fileIn = h("input", { type: "file", accept: "image/*", hidden: true, onchange: (e) => e.target.files[0] && setFile(e.target.files[0]) });
  const drawImg = () => {
    const src = img === undefined ? curImg : img;
    mount(imgBox,
      src ? h("img", { src, alt: "ภาพโจทย์" }) : h("p", { class: "sub" }, "ไม่มีภาพ · ลากภาพมาวาง เลือกไฟล์ หรือกด Ctrl/⌘+V"),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => fileIn.click() }, src ? "เปลี่ยนภาพ" : "เลือกภาพ"),
        src ? h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => { img = null; drawImg(); } }, "ลบภาพ") : null),
      fileIn);
  };
  const setFile = async (f) => { try { img = (await compressImage(f)).data; drawImg(); } catch (e) { toast(e.message, "err"); } };
  drawImg();
  const field = (lab, ctl, hint) => h("div", { class: "fld" }, h("label", { for: ctl.id }, lab), ctl, hint ? h("p", { class: "sub" }, hint) : null);
  const save = h("button", { type: "button", class: "btn btn-primary" }, "บันทึก");
  const body = h("div", { class: "ed" },
    h("div", { class: "ed-col" },
      field("ป้ายกำกับ (ไม่บังคับ)", label, "ใช้จับคู่กับช่องบนกระดานของทีม"),
      field("โจทย์", text),
      h("div", { class: "fld" }, h("span", { class: "lbl" }, "ภาพโจทย์"), imgBox)),
    h("div", { class: "ed-col" },
      field("คำตอบที่ยอมรับ", acc, "ระบบไม่สนตัวพิมพ์เล็ก/ใหญ่ ช่องว่าง เครื่องหมาย และยอมให้สะกดผิด 1–2 ตัวในคำยาว"),
      field("คำเฉลยที่แสดงบนจอ", disp),
      field("เวลาตอบ (วินาที)", secs)));
  const dlg = dialog(q ? "แก้ไขโจทย์" : "เพิ่มโจทย์", body, [h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "ยกเลิก"), save]);
  dlg.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (item) { e.preventDefault(); setFile(item.getAsFile()); }
  });
  dlg.addEventListener("dragover", (e) => e.preventDefault());
  dlg.addEventListener("drop", (e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); setFile(f); } });
  save.addEventListener("click", () => busy(save, async () => {
    const hasImg = img === undefined ? !!curImg : !!img;
    if (!text.value.trim() && !hasImg) { toast("ใส่โจทย์เป็นข้อความหรือภาพอย่างน้อย 1 อย่าง", "err"); text.focus(); return; }
    await saveQuestion(id, {
      label: label.value.trim(), text: text.value.trim(), accepted: splitAccepted(acc.value.replace(/,/g, "\n")),
      display: disp.value.trim(), secs: Math.min(300, Math.max(5, parseInt(secs.value, 10) || DEFAULT_SECS)),
    }, img);
    toast("บันทึกแล้ว", "ok"); dlg.close();
  }));
  setTimeout(() => (q ? acc : text).focus(), 50);
}

function openTextImport() {
  const ta = h("textarea", { id: "imp-text", class: "inp mono", rows: "14", placeholder: "วางโจทย์ที่นี่" });
  const pv = h("div", { class: "imp-preview", "aria-live": "polite" });
  const go = h("button", { type: "button", class: "btn btn-primary", disabled: true }, "นำเข้า");
  let parsed = [];
  const update = () => {
    parsed = parseTextImport(ta.value);
    go.disabled = !parsed.length; go.textContent = parsed.length ? `นำเข้า ${parsed.length} ข้อ` : "นำเข้า";
    mount(pv, parsed.length ? h("ol", {}, parsed.map((q) => h("li", {},
      q.label ? h("span", { class: "tag" }, q.label) : null, " ", q.text || h("em", {}, "(ไม่มีโจทย์)"),
      h("div", { class: "chips" }, q.accepted.length ? q.accepted.map((a) => h("span", { class: "chip" }, a)) : h("span", { class: "tag tag-warn" }, "ไม่มีคำตอบ"))))) : h("p", { class: "sub" }, "ตัวอย่างจะขึ้นที่นี่"));
  };
  ta.addEventListener("input", update);
  update();
  const help = h("details", { class: "imp-help", open: true }, h("summary", {}, "รูปแบบที่รองรับ"),
    h("pre", {}, "เว้น 1 บรรทัดระหว่างข้อ\n\nผู้ป่วย ARDS ควรตั้ง tidal volume กี่ mL/kg PBW\nตอบ: 6, 6 mL/kg, หก\nป้าย: Setting 10\nเวลา: 30\n\nWaveform นี้คือ asynchrony ชนิดใด\nตอบ: double triggering, double trigger\nเฉลย: Double triggering\n\nหรือแบบบรรทัดเดียว:  โจทย์ | คำตอบ1, คำตอบ2"));
  const dlg = dialog("นำเข้าโจทย์จากข้อความ", h("div", { class: "imp" }, h("div", {}, help, h("label", { for: "imp-text", class: "lbl" }, "ข้อความ"), ta), pv),
    [h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "ยกเลิก"), go]);
  go.addEventListener("click", () => busy(go, async () => {
    let order = nextOrder();
    const ops = parsed.map((q) => ({ op: "set", path: `${P.bank}/${newId()}`, data: { label: q.label, text: q.text, accepted: q.accepted, display: q.display, secs: q.secs || config.defaultSecs || DEFAULT_SECS, hasImg: false, order: order++, createdAt: db.TS } }));
    for (let i = 0; i < ops.length; i += 400) await db.batch(ops.slice(i, i + 400));
    toast(`นำเข้าแล้ว ${ops.length} ข้อ`, "ok"); dlg.close();
  }));
  setTimeout(() => ta.focus(), 50);
}

// ---------------------------------------------------------------- RESULTS pane
function renderResults() {
  const el = panes.results;
  if (!el || el.hidden) return;
  const { all, finals } = leaderboard();
  const scored = all.filter((t) => t.score > 0);
  const perQ = [...finals].sort((a, b) => a.no - b.no);
  mount(el, h("div", { class: "res" },
    h("div", { class: "bank-bar" },
      h("div", {}, h("h2", {}, "ผลคะแนน"), h("p", { class: "sub" }, `${nf(players.size)} คนเข้าร่วม · เฉลยแล้ว ${perQ.length} ข้อ`)),
      h("div", { class: "actions wrap" },
        h("button", { class: "btn", onclick: () => exportScores(all) }, "CSV คะแนนรวม"),
        h("button", { class: "btn", onclick: () => exportWinners(perQ, scored) }, "CSV ผู้ได้รางวัล"),
        h("button", { class: "btn", onclick: (e) => busy(e.currentTarget, exportAnswers) }, "CSV คำตอบทั้งหมด"))),
    h("div", { class: "res-grid" },
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "รางวัลรายข้อ")),
        perQ.length ? h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, h("th", {}, "ข้อ"), h("th", {}, "ส่ง/ถูก"), h("th", {}, "ผู้ตอบถูกเร็วที่สุด"), h("th", {}, ""))),
          h("tbody", {}, perQ.map((r) => h("tr", {},
            h("td", {}, `${r.no}${r.label ? " · " + r.label : ""}`),
            h("td", { class: "num" }, `${r.answered}/${r.correctN}`),
            h("td", {}, r.winner ? [h("strong", {}, r.winner.name), h("div", { class: "sub" }, `${r.winner.inst} · ${fmtSec(r.winner.ms)} วิ`)] : "—"),
            h("td", {}, h("button", { class: "btn btn-sm", onclick: () => { judgeOverride = r.qid; liveEls.judgeHead.dataset.qid = ""; watchAnswers(r.qid); renderJudge(); window.__selectTab("live"); } }, "ตรวจใหม่"))))))
          : h("p", { class: "empty" }, "ยังไม่มีข้อที่เฉลย")),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "อันดับคะแนนรวม")),
        scored.length ? h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "ชื่อ"), h("th", {}, "ถูก"), h("th", {}, "คะแนน"))),
          h("tbody", {}, scored.slice(0, 100).map((t) => h("tr", {},
            h("td", { class: "num" }, t.rank), h("td", {}, h("strong", {}, t.name), h("div", { class: "sub" }, t.inst)),
            h("td", { class: "num" }, t.correct), h("td", { class: "num" }, nf(t.score))))))
          : h("p", { class: "empty" }, "ยังไม่มีคะแนน")))));
}
function exportScores(all) {
  downloadCSV("audience-scores.csv", [["อันดับ", "ชื่อ", "สถาบัน", "คะแนน", "ตอบถูก (ข้อ)", "เวลารวมข้อที่ถูก (วิ)"],
    ...all.map((t) => [t.rank, t.name, t.inst, t.score, t.correct, fmtSec(t.ms)])]);
}
function exportWinners(perQ, scored) {
  downloadCSV("audience-winners.csv", [["รางวัล", "ชื่อ", "สถาบัน", "รายละเอียด"],
    ...scored.slice(0, 3).map((t) => [`คะแนนรวมอันดับ ${t.rank}`, t.name, t.inst, `${t.score} คะแนน`]),
    ...perQ.filter((r) => r.winner).map((r) => [`เร็วที่สุด ข้อ ${r.no}${r.label ? " (" + r.label + ")" : ""}`, r.winner.name, r.winner.inst, `${fmtSec(r.winner.ms)} วิ`])]);
}
async function exportAnswers() {
  const rows = await db.list(P.answers);
  const byQ = new Map([...results.values()].map((r) => [r.qid, r]));
  downloadCSV("audience-answers.csv", [["ข้อ", "ป้าย", "ชื่อ", "สถาบัน", "คำตอบ", "ผล", "เวลา (วิ)", "คะแนน", "ส่งเมื่อ"],
    ...rows.map((a) => {
      const r = byQ.get(a.qid) || {}; const q = bankById(a.qid); const p = players.get(a.uid);
      const sc = r.scores?.[a.uid];
      return [r.no || q?.usedNo || "", q?.label || r.label || "", p?.name || "", p?.inst || "", a.text, r.scores ? (sc ? "ถูก" : "ผิด") : "ยังไม่เฉลย", r.openedAt ? fmtSec(a.at - r.openedAt) : "", sc ? sc[0] : 0, fmtDate(a.at)];
    }).sort((x, y) => (+x[0] || 0) - (+y[0] || 0))]);
}

// ---------------------------------------------------------------- SETTINGS pane
let settingsBuilt = false;
function renderSettings() {
  const el = panes.settings;
  if (!el) return;
  if (settingsBuilt && el.contains(document.activeElement)) return;
  settingsBuilt = true;
  const title = h("input", { id: "st-title", class: "inp", value: config.title || "The Ventilator Games" });
  const secs = h("input", { id: "st-secs", class: "inp", type: "number", min: "5", max: "300", value: String(config.defaultSecs || DEFAULT_SECS) });
  const one = h("input", { id: "st-one", type: "checkbox", checked: config.onePrize !== false });
  const save = h("button", { class: "btn btn-primary" }, "บันทึกการตั้งค่า");
  save.addEventListener("click", () => busy(save, async () => {
    await db.set(P.config, { title: title.value.trim() || "The Ventilator Games", defaultSecs: Math.min(300, Math.max(5, parseInt(secs.value, 10) || DEFAULT_SECS)), onePrize: one.checked }, true);
    toast("บันทึกแล้ว", "ok");
  }));
  const playURL = pageURL("index.html");
  const confirmIn = h("input", { id: "st-confirm", class: "inp", placeholder: "พิมพ์คำว่า ล้าง" });
  const resetBtn = h("button", { class: "btn btn-danger" }, "เริ่มเกมใหม่");
  resetBtn.addEventListener("click", () => {
    if (confirmIn.value.trim() !== "ล้าง") { toast("พิมพ์คำว่า “ล้าง” เพื่อยืนยัน", "err"); confirmIn.focus(); return; }
    busy(resetBtn, async () => { await resetGame(); confirmIn.value = ""; toast("เริ่มเกมใหม่แล้ว คลังโจทย์ยังอยู่ครบ", "ok"); });
  });
  mount(el, h("div", { class: "set" },
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "การตั้งค่าเกม")),
      h("div", { class: "fld" }, h("label", { for: "st-title" }, "ชื่อที่แสดงบนจอและมือถือ"), title),
      h("div", { class: "fld" }, h("label", { for: "st-secs" }, "เวลาตอบเริ่มต้น (วินาที)"), secs),
      h("div", { class: "fld check" }, one, h("label", { for: "st-one" }, "1 คนรับรางวัลรายข้อได้ครั้งเดียว (ถ้าคนเดิมตอบเร็วสุดอีก ให้คนถัดไป)")),
      h("p", { class: "sub" }, "คะแนน: ตอบถูกได้ 500–1,000 ตามความเร็ว (ตอบทันทีได้ 1,000 ตอบตอนหมดเวลาได้ 500) ตอบผิดได้ 0 · เสมอกันตัดสินด้วยเวลารวมที่น้อยกว่า"),
      h("div", { class: "actions" }, save)),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "ลิงก์และ QR")),
      h("div", { class: "qr-row" }, h("div", { class: "qr", html: qrSVG(playURL) }),
        h("div", {}, h("p", { class: "lbl" }, "หน้าผู้ชม"), h("p", { class: "url" }, prettyURL(playURL)),
          h("div", { class: "actions wrap" },
            h("button", { class: "btn btn-sm", onclick: () => navigator.clipboard.writeText(playURL).then(() => toast("คัดลอกแล้ว", "ok")) }, "คัดลอกลิงก์"),
            h("button", { class: "btn btn-sm", onclick: () => downloadBlob("audience-qr.svg", new Blob([qrSVG(playURL)], { type: "image/svg+xml" })) }, "ดาวน์โหลด QR")))),
      h("p", { class: "lbl" }, "จอหลัก (ไม่ต้องใส่ PIN)"), h("p", { class: "url" }, prettyURL(pageURL("screen.html"))),
      h("p", { class: "lbl" }, "Host"), h("p", { class: "url" }, prettyURL(pageURL("host.html")))),
    h("section", { class: "card danger" }, h("div", { class: "card-head" }, h("h2", {}, "เริ่มเกมใหม่")),
      h("p", {}, "ลบผู้ร่วมเล่น คำตอบ และคะแนนทั้งหมด (คลังโจทย์ยังอยู่) · ใช้หลังซ้อม และก่อนเริ่มงานจริง"),
      h("div", { class: "fld" }, h("label", { for: "st-confirm" }, "ยืนยัน"), confirmIn),
      h("div", { class: "actions" }, resetBtn))));
}
