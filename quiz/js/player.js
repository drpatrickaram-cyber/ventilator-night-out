// Player page: join → wait → answer (open text, once) → see result → final rank.
import { initDB } from "./db.js";
import { h, mount, $, P, MAX_ANSWER, remainingMs, fmtSec, nf, keepAwake, toast } from "./core.js";

const app = $("#app");
const chip = $("#me-chip");
let db, me = null, state = null, pub = null, board = null, config = {};
let mine = {};            // qid -> { text, ms }
const checked = new Set(); // qids whose server copy we already looked up
let viewKey = "", session = null, ready = false;

const ICON_OK = '<svg class="p-icon" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-width="3"/><path d="M14 25l7 7 13-15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRACE = '<svg class="p-trace" viewBox="0 0 320 64" preserveAspectRatio="none" aria-hidden="true"><path d="M0 48 H40 L52 14 H96 L104 48 H150 L162 14 H206 L214 48 H260 L272 14 H316 L320 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>';

const lsKey = () => `vq-ans-${db.uid}-${session || "0"}`;
function loadLocal() { try { mine = JSON.parse(localStorage.getItem(lsKey()) || "{}"); } catch (e) { mine = {}; } }
function saveLocal() { try { localStorage.setItem(lsKey(), JSON.stringify(mine)); } catch (e) { /* private mode */ } }

const myRank = () => (board?.ranks?.[db.uid] ? { score: board.ranks[db.uid][0], rank: board.ranks[db.uid][1], last: board.ranks[db.uid][2], correct: board.ranks[db.uid][3] } : null);

boot();
async function boot() {
  try { db = await initDB(); } catch (e) { mount(app, h("p", { class: "p-loading" }, "เชื่อมต่อไม่ได้ ลองรีเฟรชหน้านี้")); return; }
  db.onDoc(P.config, (d) => { config = d || {}; render(); });
  db.onDoc(P.pub, (d) => { pub = d; render(); });
  db.onDoc(P.board, (d) => { board = d; render(); });
  db.onDoc(P.state, async (d) => {
    state = d;
    const s = d?.session || "0";
    if (s !== session) {
      session = s; loadLocal(); checked.clear();
      me = await db.get(`${P.players}/${db.uid}`).catch(() => null);
      ready = true;
    }
    render();
  });
  keepAwake();
  tick();
}

function render() {
  if (!ready) return;
  const r = myRank();
  chip.hidden = !me || !r;
  if (me && r) chip.innerHTML = `อันดับ <b>${r.rank}</b> · ${nf(r.score)} คะแนน`;

  const phase = state?.phase || "lobby";
  const qid = state?.qid || "";
  const key = !me ? "join" : [phase, qid, pub?.qid, mine[qid] ? 1 : 0, phase === "reveal" || phase === "board" || phase === "final" ? board?.v : "", state?.reveal?.winner?.uid || ""].join("|");
  if (key === viewKey) return;
  viewKey = key;

  if (!me) return mount(app, joinView());
  if (phase === "question" || phase === "closed") {
    if (pub?.qid !== qid) return mount(app, waitView("กำลังโหลดคำถาม…"));
    if (!mine[qid] && !checked.has(qid)) lookupMine(qid);
    if (mine[qid]) return mount(app, sentView(qid, phase));
    if (phase === "closed") return mount(app, missedView());
    return mount(app, questionView());
  }
  if (phase === "reveal" || phase === "board") return mount(app, resultView());
  if (phase === "final") return mount(app, finalView());
  return mount(app, waitView());
}

async function lookupMine(qid) {
  checked.add(qid);
  const a = await db.get(`${P.answers}/${qid}_${db.uid}`).catch(() => null);
  if (a && !mine[qid]) { mine[qid] = { text: a.text, ms: Math.max(0, a.at - (state?.openedAt || a.at)) }; saveLocal(); viewKey = ""; render(); }
}

// ---------------------------------------------------------------- views
function joinView() {
  const err = h("p", { class: "p-err", role: "alert" });
  const name = h("input", { id: "nm", class: "p-input", maxlength: "60", autocomplete: "name", placeholder: "เช่น นพ.สมชาย ใจดี", required: true });
  const inst = h("input", { id: "inst", class: "p-input", maxlength: "80", autocomplete: "organization", placeholder: "เช่น รพ.พระมงกุฎเกล้า", required: true });
  const btn = h("button", { type: "submit", class: "p-btn" }, "เข้าร่วม");
  const submit = async (e) => {
    e.preventDefault();
    const n = name.value.trim(), i = inst.value.trim();
    name.setAttribute("aria-invalid", String(!n)); inst.setAttribute("aria-invalid", String(!i));
    if (!n || !i) { err.textContent = "กรุณากรอกชื่อและสถาบัน"; (n ? inst : name).focus(); return; }
    btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "กำลังเข้าร่วม…";
    try {
      await db.set(`${P.players}/${db.uid}`, { name: n, inst: i, at: db.TS });
      me = { name: n, inst: i }; viewKey = ""; render();
    } catch (x) {
      err.textContent = "เข้าร่วมไม่สำเร็จ ลองอีกครั้ง"; btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = "เข้าร่วม";
    }
  };
  return h("form", { class: "p-form p-pop", onsubmit: submit, novalidate: true },
    h("p", { class: "p-kicker" }, config.title || "The Ventilator Games"),
    h("h1", { class: "p-title" }, "ร่วมตอบคำถาม"),
    h("p", { class: "p-lead" }, "พิมพ์คำตอบจากมือถือ ไปพร้อมกับทีมบนเวที"),
    h("div", { class: "p-rules" },
      h("div", {}, h("b", {}, "ตอบถูกและเร็ว"), " ยิ่งได้คะแนนมาก (500–1,000 ต่อข้อ)"),
      h("div", {}, h("b", {}, "ส่งได้ครั้งเดียว"), " ต่อข้อ แก้ไขไม่ได้"),
      h("div", {}, h("b", {}, "รางวัล"), " ผู้ตอบถูกเร็วที่สุดแต่ละข้อ และคะแนนรวมสูงสุด")),
    h("div", { class: "p-field" }, h("label", { for: "nm" }, "ชื่อ-สกุล"), name),
    h("div", { class: "p-field" }, h("label", { for: "inst" }, "สถาบัน"), inst),
    err, btn,
    h("p", { class: "p-note" }, "ชื่อของคุณอาจขึ้นบนจอใหญ่เมื่อได้รางวัล"));
}

function statsRow() {
  const r = myRank();
  if (!r) return null;
  return h("div", { class: "p-stats" },
    h("div", { class: "p-stat" }, h("span", {}, "คะแนนรวม"), h("strong", {}, nf(r.score))),
    h("div", { class: "p-stat" }, h("span", {}, "อันดับ"), h("strong", {}, `${r.rank}`, h("small", { class: "p-muted" }, ` / ${nf(board.n)}`))));
}

function waitView(msg) {
  return h("section", { class: "p-wait p-pop" },
    h("p", { class: "p-kicker" }, `สวัสดี ${me.name}`),
    h("h1", { class: "p-title" }, msg || "รอคำถามข้อถัดไป"),
    h("div", { html: TRACE }),
    h("p", { class: "p-lead" }, "เมื่อทีมบนเวทีเลือกข้อ คำถามจะขึ้นที่หน้านี้เอง ไม่ต้องรีเฟรช"),
    statsRow());
}

function clockBlock() {
  return [
    h("div", { class: "p-q-head" },
      h("p", { class: "p-kicker" }, `ข้อ ${pub.no}${pub.label ? " · " + pub.label : ""}`),
      h("span", { class: "p-clock", id: "clock", role: "timer", "aria-label": "เวลาที่เหลือ" }, "")),
    h("div", { class: "p-bar", id: "bar" }, h("i", {})),
  ];
}

function questionImage() {
  if (!pub.img) return null;
  const open = () => {
    const z = h("button", { class: "p-zoom", type: "button", "aria-label": "ปิดภาพขยาย", onclick: () => z.remove() }, h("img", { src: pub.img, alt: "ภาพโจทย์ขยาย" }));
    document.body.appendChild(z); z.focus();
  };
  return h("button", { type: "button", class: "p-q-img", onclick: open, "aria-label": "แตะเพื่อขยายภาพโจทย์" }, h("img", { src: pub.img, alt: "ภาพประกอบโจทย์" }));
}

function questionView() {
  const qid = state.qid;
  const input = h("input", { id: "ans", class: "p-input", maxlength: String(MAX_ANSWER), autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "send", placeholder: "พิมพ์คำตอบ", "aria-label": "คำตอบของคุณ" });
  const err = h("p", { class: "p-err", role: "alert" });
  const btn = h("button", { type: "submit", class: "p-btn" }, "ส่งคำตอบ");
  const send = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { err.textContent = "พิมพ์คำตอบก่อนส่ง"; input.focus(); return; }
    if (remainingMs(state, db.now()) <= 0) { err.textContent = "หมดเวลาแล้ว"; return; }
    btn.disabled = true; input.readOnly = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "กำลังส่ง…";
    try {
      await db.create(`${P.answers}/${qid}_${db.uid}`, { qid, uid: db.uid, text, at: db.TS });
      const saved = await db.get(`${P.answers}/${qid}_${db.uid}`).catch(() => null);
      mine[qid] = { text, ms: saved ? Math.max(0, saved.at - state.openedAt) : null };
      saveLocal(); render();
    } catch (x) {
      const saved = await db.get(`${P.answers}/${qid}_${db.uid}`).catch(() => null);
      if (saved) { mine[qid] = { text: saved.text, ms: Math.max(0, saved.at - state.openedAt) }; saveLocal(); render(); return; }
      err.textContent = remainingMs(state, db.now()) <= 0 ? "หมดเวลาส่งคำตอบแล้ว" : "ส่งไม่สำเร็จ ลองกดอีกครั้ง";
      btn.disabled = false; input.readOnly = false; btn.removeAttribute("aria-busy"); btn.textContent = "ส่งคำตอบ";
    }
  };
  setTimeout(() => input.focus({ preventScroll: true }), 60);
  return h("section", { class: "p-pop", style: { display: "flex", flexDirection: "column", gap: "var(--space-md)" } },
    clockBlock(),
    questionImage(),
    pub.text ? h("p", { class: "p-q-text" }, pub.text) : null,
    h("form", { class: "p-answer", onsubmit: send, novalidate: true }, input, err, btn,
      h("p", { class: "p-note" }, "ส่งได้ครั้งเดียว · ยิ่งเร็วยิ่งได้คะแนนมาก")));
}

function sentView(qid, phase) {
  const a = mine[qid];
  return h("section", { class: "p-pop", style: { display: "flex", flexDirection: "column", gap: "var(--space-md)" } },
    phase === "question" ? clockBlock() : null,
    h("div", { class: "p-state" },
      h("div", { html: ICON_OK, style: { color: "var(--color-go)" } }),
      h("h2", {}, "ส่งคำตอบแล้ว"),
      h("div", { class: "p-yours" }, a.text),
      a.ms != null ? h("p", { class: "p-lead" }, `ใช้เวลา ${fmtSec(a.ms)} วินาที`) : null),
    h("p", { class: "p-lead" }, phase === "question" ? "รอหมดเวลา แล้วเฉลยจะขึ้นที่จอใหญ่และหน้านี้" : "หมดเวลา · รอเฉลย"));
}

function missedView() {
  return h("section", { class: "p-state p-pop" },
    h("h2", {}, "หมดเวลา"),
    h("p", { class: "p-lead" }, "ข้อนี้คุณไม่ได้ส่งคำตอบ · รอเฉลยและข้อถัดไป"));
}

function resultView() {
  const qid = state.qid;
  const a = mine[qid];
  const rv = state.reveal && state.reveal.qid === qid ? state.reveal : null;
  const r = myRank();
  const fresh = board?.qid === qid;
  const pts = fresh && r ? r.last : null;
  const iWon = rv?.winner?.uid === db.uid;
  let card;
  if (!rv) card = h("div", { class: "p-state" }, h("h2", {}, "กำลังตรวจคำตอบ…"));
  else if (!a) card = h("div", { class: "p-state bad" }, h("h2", {}, "ไม่ได้ตอบข้อนี้"), h("p", { class: "p-lead" }, "ข้อถัดไปยังมีโอกาส"));
  else if (pts > 0) card = h("div", { class: "p-state ok" },
    h("h2", {}, "ถูกต้อง"), h("p", { class: "p-points" }, `+${nf(pts)}`),
    h("div", { class: "p-yours" }, a.text),
    a.ms != null ? h("p", { class: "p-lead" }, `ใช้เวลา ${fmtSec(a.ms)} วินาที`) : null);
  else card = h("div", { class: "p-state bad" },
    h("h2", {}, fresh ? "ยังไม่ถูก" : "กำลังตรวจ…"), h("div", { class: "p-yours" }, a.text));
  return h("section", { class: "p-pop", style: { display: "flex", flexDirection: "column", gap: "var(--space-md)" } },
    h("p", { class: "p-kicker" }, `ข้อ ${pub?.qid === qid ? pub.no : ""} · เฉลย`),
    card,
    rv?.answer ? h("div", { class: "p-reveal" }, h("span", {}, "คำตอบที่ถูก"), h("strong", {}, rv.answer)) : null,
    iWon ? h("div", { class: "p-win", role: "status" }, h("strong", {}, "คุณตอบถูกเร็วที่สุดข้อนี้"), "รับรางวัลที่โต๊ะลงทะเบียนหลังจบเกม") : null,
    statsRow());
}

function finalView() {
  const r = myRank();
  const won = (board?.winners || []).filter((w) => w.uid === db.uid);
  const top = r && r.rank <= 3;
  return h("section", { class: "p-wait p-pop" },
    h("p", { class: "p-kicker" }, "จบเกม"),
    h("h1", { class: "p-title" }, top ? `อันดับ ${r.rank} คะแนนรวม` : "ขอบคุณที่ร่วมสนุก"),
    statsRow(),
    r ? h("p", { class: "p-lead" }, `ตอบถูก ${r.correct} ข้อ`) : h("p", { class: "p-lead" }, "ยังไม่มีคะแนน"),
    top || won.length ? h("div", { class: "p-win" }, h("strong", {}, "คุณได้รางวัล"),
      [top ? `คะแนนรวมอันดับ ${r.rank}` : null, ...won.map((w) => `ตอบเร็วที่สุด ข้อ ${w.no}`)].filter(Boolean).join(" · "),
      h("div", {}, "ติดต่อรับรางวัลที่โต๊ะลงทะเบียน")) : null);
}

// ---------------------------------------------------------------- countdown
let lastSec = -1;
function tick() {
  const clock = document.getElementById("clock");
  const bar = document.getElementById("bar");
  if (clock && state?.phase === "question" && db) {
    const ms = remainingMs(state, db.now());
    const s = Math.ceil(ms / 1000);
    if (s !== lastSec) { lastSec = s; clock.textContent = String(s); clock.classList.toggle("low", s <= 5); bar.classList.toggle("low", s <= 5); }
    bar.firstChild.style.transform = `scaleX(${ms / ((state.secs || 30) * 1000)})`;
    if (ms <= 0 && !mine[state.qid] && document.getElementById("ans")) { const i = document.getElementById("ans"); i.readOnly = true; }
  } else if (clock) { clock.textContent = "0"; bar.firstChild.style.transform = "scaleX(0)"; }
  requestAnimationFrame(tick);
}
window.addEventListener("error", (e) => toast("เกิดข้อผิดพลาด: " + e.message, "err"));
