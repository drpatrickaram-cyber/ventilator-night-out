import { initDB } from "./db.js";
import { h, mount, $, tileInfo, teamName, secsLeft, toast } from "./core.js";

const app = $("#app");
const params = new URLSearchParams(location.search);
const signupOnly = params.has("signup");
const POSITIONS = ["Fellow", "Staff", "Resident", "Nurse", "RT", "อื่นๆ"];

let db, me = null, game = null, cur = null, rev = null, signup = {}, myAnswer = null, myAnsQid = null;
let member = JSON.parse(localStorage.getItem("vno-member") || "null");
let sheetDismissed = false, sheetOpen = false, busy = false;
let draft = "";

const keyOf = (email) => email.trim().toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 120);

// ---------------- join ----------------
function joinView() {
  const name = h("input", { type: "text", id: "nm", autocomplete: "name", maxlength: "60", required: true, value: me?.name || "" });
  const inst = h("input", { type: "text", id: "inst", autocomplete: "organization", maxlength: "80", required: true, value: me?.inst || "" });
  const err = h("p", { class: "err", role: "alert" });
  const submit = async (e) => {
    e.preventDefault();
    const n = name.value.trim(), i = inst.value.trim();
    if (!n || !i) { err.textContent = "กรุณากรอกชื่อและสถาบัน"; return; }
    try { await db.set(`players/${db.uid}`, { name: n, inst: i, at: db.TS }); me = { name: n, inst: i }; render(); }
    catch (x) { console.error(x); err.textContent = "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"; }
  };
  return [
    h("div", { class: "a-hero" }, h("div", { class: "kicker" }, "VENTILATOR NIGHT OUT · THE FIRST WAVE"), h("h1", {}, "The Ventilator Games"), h("p", { class: "muted" }, "ตอบคำถามไปพร้อมกับทีม fellow · คนที่ตอบถูกเร็วที่สุดของแต่ละข้อรับรางวัล")),
    h("form", { class: "a-card", onsubmit: submit },
      h("h1", {}, "ลงชื่อเข้าร่วม"),
      h("div", { class: "field" }, h("label", { for: "nm" }, "ชื่อ-สกุล"), name),
      h("div", { class: "field" }, h("label", { for: "inst" }, "สถาบัน"), inst),
      err, h("button", { type: "submit", class: "btn primary big" }, "เข้าร่วม")),
  ];
}

// ---------------- game ----------------
function myWins() { return Object.entries(game?.audWinners || {}).filter(([, w]) => w?.uid === db.uid).map(([q]) => q); }

function waitCard(text, sub) { return h("div", { class: "a-card dim wait" }, h("div", { class: "big" }, text), sub ? h("div", { class: "muted" }, sub) : null); }

function questionView(g) {
  if (!cur || cur.qid !== g.qid) return waitCard("กำลังโหลดคำถาม…");
  const info = tileInfo(cur.qid);
  const s = secsLeft(g, db.now());
  const open = g.ansOpen && s > 0 && g.phase === "question";
  const isRev = g.phase === "reveal" && rev?.qid === cur.qid;
  const mine = myAnsQid === cur.qid ? myAnswer : null;
  const head = h("div", { class: "chip-row" }, h("span", { class: "chip" }, info.catObj.short), h("span", { class: "chip pts" }, cur.sd ? "Sudden death" : `${info.pts}`),
    !isRev ? h("span", { class: `a-timer ${s <= 5 ? "low" : ""}`, id: "atimer" }, open ? `เหลือ ${s} วิ` : "ปิดรับคำตอบ") : null);
  const kids = [head, h("div", { class: "a-q" }, cur.aPrompt || cur.prompt), cur.hasImg ? h("div", { class: "muted", style: { fontSize: "14px" } }, "ดูภาพประกอบบนจอใหญ่") : null];

  if (cur.aType === "mcq") {
    kids.push(...cur.options.map((o, i) => {
      const L = "ABCD"[i];
      const cls = [isRev && rev.correctOption === L ? "right" : "", mine?.choice === L ? "mine" : ""].join(" ");
      return h("button", { class: `btn opt-btn ${cls}`, disabled: !open || !!mine || busy, onclick: () => answer({ choice: L }) }, h("b", {}, L), o);
    }));
  } else if (!mine) {
    const inp = h("input", { type: "text", id: "ans", maxlength: "80", autocomplete: "off", value: draft, disabled: !open || busy, placeholder: "พิมพ์คำตอบสั้น ๆ", oninput: (e) => { draft = e.target.value; } });
    kids.push(h("form", { class: "field", onsubmit: (e) => { e.preventDefault(); const t = inp.value.trim(); if (t) answer({ text: t }); } },
      h("label", { for: "ans" }, "คำตอบของคุณ (ส่งได้ครั้งเดียว)"), inp,
      h("button", { type: "submit", class: "btn primary big", disabled: !open || busy }, "ส่งคำตอบ")));
  }
  if (mine) kids.push(h("div", { class: "ok-box" }, `ส่งแล้ว: ${mine.choice || mine.text}`, isRev ? null : " · รอเฉลย"));
  else if (!open && !isRev) kids.push(h("div", { class: "no-box" }, "หมดเวลาตอบข้อนี้"));
  if (isRev) {
    kids.push(h("div", { class: "a-card dim", style: { padding: "14px" } }, h("div", { class: "muted", style: { fontSize: "13px" } }, "เฉลย"), h("div", { style: { fontWeight: "700", fontSize: "18px" } }, rev.answerShort)));
    const aw = g.audWinner;
    if (aw?.uid === db.uid) kids.push(h("div", { class: "win-box" }, "🎉 คุณตอบถูกเร็วที่สุด! รอรับรางวัลตอนประกาศผล"));
    else if (aw) kids.push(h("div", { class: "muted" }, `ผู้ชมที่ตอบถูกเร็วที่สุด: ${aw.name}`));
  }
  return h("div", { class: "a-card" }, kids);
}

async function answer(a) {
  if (busy) return;
  busy = true; render();
  const g = game;
  try {
    await db.create(`answers/${g.qid}_${db.uid}`, { qid: g.qid, uid: db.uid, name: me.name, inst: me.inst, ...a, at: db.TS });
    myAnswer = a; myAnsQid = g.qid; draft = "";
  } catch (e) {
    console.warn(e);
    const existing = await db.get(`answers/${g.qid}_${db.uid}`).catch(() => null);
    if (existing) { myAnswer = existing; myAnsQid = g.qid; } else toast("ส่งไม่ทัน หรือปิดรับคำตอบแล้ว", "bad");
  }
  busy = false; render();
}

function gameView(g) {
  const wins = myWins();
  const winNote = wins.length ? h("div", { class: "win-box" }, `🎉 คุณได้รางวัลผู้ชม (ข้อ ${wins.join(", ")}) — รอเรียกชื่อตอนประกาศรางวัล`) : null;
  let body;
  if (!g) body = waitCard("รอเริ่มงาน…");
  else if (g.phase === "question" || g.phase === "reveal") body = questionView(g);
  else if (g.phase === "board") body = waitCard(g.buzzWinner ? `${teamName(g, g.buzzWinner.team)} กำลังเลือกช่อง…` : "รอทีมเลือกข้อถัดไป…", "คำถามจะเด้งขึ้นที่นี่อัตโนมัติ");
  else if (g.phase === "end") body = waitCard("จบเกมแล้ว ขอบคุณที่ร่วมเล่น!", "ผลรางวัลประกาศช่วงท้ายงาน");
  else if (g.phase === "awards") body = waitCard("ประกาศรางวัล 🏆");
  else if (g.phase === "wall") body = waitCard("Be the First Wave", member ? "ขอบคุณที่ร่วมเป็น Founding Member" : signup.open ? "สมัคร Founding Member ได้ที่ปุ่มด้านล่าง" : "เร็ว ๆ นี้");
  else body = waitCard("รอเกมเริ่ม…", "เมื่อทีม fellow เลือกข้อ คำถามจะเด้งขึ้นที่นี่");
  const joinBtn = signup.open && !member ? h("button", { class: "btn amber big", onclick: () => { sheetDismissed = false; openSheet(); } }, "สมัคร Founding Member") : null;
  const memberCard = member ? memberView(member) : null;
  return [winNote, body, joinBtn, memberCard];
}

// ---------------- signup ----------------
function memberView(m) {
  return h("div", { class: "member", style: { background: "var(--navy-2)" } },
    h("div", { class: "kicker" }, "MECHANICAL VENTILATOR ASSEMBLY"),
    h("div", {}, "Founding Member · First Wave 2026"),
    h("div", { class: "no" }, m.no ? `#${String(m.no).padStart(3, "0")}` : "✓"),
    h("div", { class: "nm" }, m.name), h("div", { class: "muted" }, m.inst),
    h("div", { style: { marginTop: "8px", fontSize: "14px" } }, "แสดงหน้านี้ที่โต๊ะลงทะเบียนเพื่อรับพวงกุญแจ"));
}

function signupForm(onDone, onLater) {
  const name = h("input", { type: "text", id: "s-nm", autocomplete: "name", maxlength: "60", value: me?.name || "" });
  const inst = h("input", { type: "text", id: "s-inst", autocomplete: "organization", maxlength: "80", value: me?.inst || "" });
  const pos = h("select", { id: "s-pos" }, h("option", { value: "" }, "เลือกตำแหน่ง"), POSITIONS.map((p) => h("option", { value: p }, p)));
  const email = h("input", { type: "email", id: "s-email", autocomplete: "email", maxlength: "120", inputmode: "email" });
  const err = h("p", { class: "err", role: "alert" });
  const go = async (e) => {
    e.preventDefault();
    const d = { name: name.value.trim(), inst: inst.value.trim(), pos: pos.value, email: email.value.trim().toLowerCase() };
    if (!d.name || !d.inst || !d.pos || !/^\S+@\S+\.\S+$/.test(d.email)) { err.textContent = "กรุณากรอกให้ครบ และใช้อีเมลที่ถูกต้อง"; return; }
    err.textContent = "กำลังบันทึก…";
    const key = keyOf(d.email);
    try {
      await db.batch([
        { op: "create", path: `members/${key}`, data: { ...d, uid: db.uid, at: db.TS } },
        { op: "create", path: `wall/${key}`, data: { name: d.name, inst: d.inst, at: db.TS } },
      ]);
    } catch (x) {
      const exists = await db.get(`wall/${key}`).catch(() => null);
      if (!exists) { console.error(x); err.textContent = signup.open ? "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง" : "ปิดรับสมัครแล้ว"; return; }
      toast("อีเมลนี้สมัครไว้แล้ว");
    }
    const w = await db.get(`wall/${key}`);
    let no = null;
    try { no = await db.count("wall", { where: [["at", "<=", db.tsv(w.at)]] }); } catch (x) { console.warn(x); }
    member = { name: w.name, inst: w.inst, no, key };
    localStorage.setItem("vno-member", JSON.stringify(member));
    onDone();
  };
  return h("form", { class: "a-card", onsubmit: go },
    h("div", { class: "kicker", style: { color: "#B07614" } }, "BE THE FIRST WAVE"),
    h("h1", {}, "สมัคร Founding Member"),
    h("p", { class: "muted", style: { margin: 0 } }, "Mechanical Ventilator Assembly · TSCCM"),
    h("div", { class: "field" }, h("label", { for: "s-nm" }, "ชื่อ-สกุล"), name),
    h("div", { class: "field" }, h("label", { for: "s-inst" }, "สถาบัน"), inst),
    h("div", { class: "field" }, h("label", { for: "s-pos" }, "ตำแหน่ง"), pos),
    h("div", { class: "field" }, h("label", { for: "s-email" }, "อีเมล"), email),
    err,
    h("button", { type: "submit", class: "btn primary big" }, "สมัครเลย"),
    onLater ? h("button", { type: "button", class: "btn ghost", onclick: onLater }, "ไว้ทีหลัง") : null);
}

function openSheet() {
  if (sheetOpen || member) return;
  sheetOpen = true;
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "สมัคร Founding Member" });
  const close = () => { sheet.remove(); sheetOpen = false; };
  sheet.appendChild(signupForm(() => { close(); render(); }, () => { sheetDismissed = true; close(); render(); }));
  document.body.appendChild(sheet);
  setTimeout(() => $("#s-pos", sheet)?.focus(), 50);
}

function signupOnlyView() {
  if (member) return [memberView(member)];
  if (!signup.open) return [h("div", { class: "a-hero" }, h("div", { class: "kicker" }, "MECHANICAL VENTILATOR ASSEMBLY"), h("h1", {}, "Be the First Wave")), waitCard("ยังไม่เปิดรับสมัคร", "หน้านี้จะเปิดฟอร์มให้อัตโนมัติเมื่อเริ่มรับสมัคร")];
  return [signupForm(() => render(), null)];
}

// ---------------- render ----------------
function render() {
  if (!db) return;
  const focusId = document.activeElement?.id;
  const top = h("div", { class: "a-top" }, h("div", { class: "kicker" }, "VENTILATOR NIGHT OUT"), me ? h("div", { class: "who" }, me.name, h("br"), me.inst) : null);
  if (signupOnly) mount(app, top, signupOnlyView());
  else if (!me) mount(app, joinView());
  else mount(app, top, gameView(game));
  if (focusId) { const el = document.getElementById(focusId); if (el && !el.disabled) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }
  if (!signupOnly && me && signup.open && signup.launched && !member && !sheetDismissed) openSheet();
}

setInterval(() => {
  const el = $("#atimer");
  if (!el || !game) return;
  const s = secsLeft(game, db.now());
  const open = game.ansOpen && s > 0;
  el.textContent = open ? `เหลือ ${s} วิ` : "ปิดรับคำตอบ";
  el.className = `a-timer ${s <= 5 ? "low" : ""}`;
  if (!open && game.phase === "question" && document.querySelector(".opt-btn:not([disabled]), #ans:not([disabled])")) render();
}, 300);

(async () => {
  mount(app, waitCard("กำลังเชื่อมต่อ…"));
  try { db = await initDB(); } catch (e) { console.error(e); mount(app, waitCard("เชื่อมต่อไม่สำเร็จ", "ตรวจสอบอินเทอร์เน็ต แล้วรีเฟรชหน้า")); return; }
  me = await db.get(`players/${db.uid}`).catch(() => null);
  render();
  let lastLaunch = null;
  db.onDoc("state/signup", (d) => {
    signup = d || {};
    if (signup.launched && lastLaunch === false) sheetDismissed = false;
    lastLaunch = !!signup.launched;
    render();
  });
  if (signupOnly) return;
  db.onDoc("state/game", (g) => {
    const qChanged = g?.qid !== game?.qid;
    game = g;
    if (qChanged && g?.qid && g.qid !== myAnsQid) {
      myAnswer = null; draft = "";
      db.get(`answers/${g.qid}_${db.uid}`).then((a) => { if (a) { myAnswer = a; myAnsQid = g.qid; render(); } }).catch(() => {});
    }
    render();
  });
  db.onDoc("pub/current", (d) => { cur = d; render(); });
  db.onDoc("pub/reveal", (d) => { rev = d; render(); });
})();
