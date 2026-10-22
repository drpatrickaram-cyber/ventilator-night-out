import { initDB } from "./db.js";
import { h, mount, $, tileInfo, staffGate, actions, toast, acceptedList, isMatch, fmtMs, secsLeft } from "./core.js";

const app = $("#app");
let db, A;
let game = null, questions = {}, answers = [];
let ansUnsub = null, ansQid = null;
const run = (fn) => async () => { try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), "bad"); } };

function render() {
  const top = h("header", { class: "p-top" }, h("h1", {}, "กรรมการตัดสินคำตอบผู้ชม"), h("div", { class: "sp" }),
    game?.qid ? h("span", { class: "pill", id: "jtimer" }, timerText()) : null);
  if (!game) { mount(app, top, h("main", { class: "p-main" }, h("div", { class: "card" }, "รอเกมเริ่ม…"))); return; }
  const g = game;
  const q = g.qid ? questions[g.qid] : null;
  const taken = new Map(Object.entries(g.audWinners || {}).filter(([k, v]) => v && k !== g.qid).map(([k, v]) => [v.uid, k]));
  const chosen = g.audWinners?.[g.qid]?.uid;

  let main;
  if (!g.qid || !q) {
    main = h("div", { class: "card" }, h("h2", {}, "ยังไม่มีโจทย์บนจอ"), h("p", { class: "muted" }, "เมื่อ GM ขึ้นโจทย์ คำตอบของผู้ชมจะไหลเข้ามาที่นี่ เรียงจากเร็วที่สุด"));
  } else {
    const acc = acceptedList(q);
    const mcq = q.aType === "mcq";
    const rows = [...answers].sort((a, b) => a.at - b.at);
    const isOk = (r) => (mcq ? r.choice === q.correct : isMatch(r.text, acc));
    const head = h("div", { class: "card" },
      h("h2", {}, h("span", { class: "pill" }, `${tileInfo(g.qid).catObj.short} ${tileInfo(g.qid).pts}`), mcq ? "ปรนัย — ระบบเลือกผู้ชนะอัตโนมัติตอนเฉลย (แก้ได้)" : "อัตนัย — กด ✓ ที่คำตอบถูกอันแรก"),
      h("div", {}, h("b", {}, "คำถามผู้ชม: "), q.aPrompt || q.prompt),
      mcq ? h("div", {}, h("b", {}, "ข้อถูก: "), `${q.correct} · ${(q.options || [])["ABCD".indexOf(q.correct)] || ""}`)
          : h("div", {}, h("b", {}, "คำตอบที่ยอมรับ: "), acc.join(", ") || "–"),
      h("div", { class: "row" }, h("span", { class: "pill" }, `ตอบแล้ว ${rows.length} คน`), h("span", { class: "pill", style: { background: "#E6F7EE" } }, `ตรงคำตอบ ${rows.filter(isOk).length} คน`),
        chosen ? h("button", { class: "btn small", onclick: run(() => A.setAudWinner(g.qid, null)) }, "ล้างผู้ชนะข้อนี้") : null));
    const table = h("table", { class: "t" },
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "เวลา"), h("th", {}, "ชื่อ"), h("th", {}, "สถาบัน"), h("th", {}, "คำตอบ"), h("th", {}, ""))),
      h("tbody", {}, rows.map((r, i) => {
        const tk = taken.get(r.uid);
        const cls = r.uid === chosen ? "chosen" : tk ? "taken" : isOk(r) ? "match" : "";
        const w = { uid: r.uid, name: r.name, inst: r.inst || "", ms: Math.max(0, r.at - (g.qOpenedAt || r.at)) };
        return h("tr", { class: cls },
          h("td", {}, String(i + 1)), h("td", {}, fmtMs(w.ms)), h("td", {}, r.name), h("td", {}, r.inst || ""),
          h("td", { style: { fontWeight: "600" } }, mcq ? r.choice : r.text),
          h("td", {}, tk ? h("span", { class: "muted", style: { fontSize: "13px" } }, `ได้รางวัลแล้ว (${tk})`)
            : h("button", { class: `btn small ${r.uid === chosen ? "amber" : ""}`, onclick: run(() => A.setAudWinner(g.qid, w)) }, r.uid === chosen ? "★ ผู้ชนะ" : "✓ เลือก")));
      })));
    main = h("div", { class: "p-col", style: { flexBasis: "100%" } }, head, h("div", { class: "card scroll" }, rows.length ? table : h("p", { class: "muted" }, "ยังไม่มีคำตอบ")));
  }
  const winners = Object.entries(g.audWinners || {}).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b));
  const wcard = h("div", { class: "card", style: { flexBasis: "100%" } }, h("h2", {}, `ผู้ชนะผู้ชมทั้งหมด ${winners.length} คน`),
    winners.length ? h("table", { class: "t" }, h("tbody", {}, winners.map(([qid, w]) => h("tr", {}, h("td", {}, qid), h("td", {}, w.name), h("td", {}, w.inst || ""),
      h("td", {}, h("button", { class: "btn small", onclick: run(() => A.setAudWinner(qid, null)) }, "ลบ")))))) : h("p", { class: "muted" }, "ยังไม่มี"));
  mount(app, top, h("main", { class: "p-main" }, main, wcard));
}

function timerText() { return game?.ansOpen ? `กำลังรับคำตอบ · ${secsLeft(game, db.now())} วิ` : "ปิดรับคำตอบแล้ว"; }
setInterval(() => { const el = $("#jtimer"); if (el) el.textContent = timerText(); }, 500);

(async () => {
  db = await initDB();
  await staffGate(db, "กรรมการผู้ชม");
  A = actions(db);
  db.onDoc("state/game", (g) => {
    game = g;
    if (g && g.qid !== ansQid) {
      ansQid = g.qid; if (ansUnsub) ansUnsub(); answers = [];
      if (g.qid) ansUnsub = db.onColl("answers", { where: [["qid", "==", g.qid]] }, (rows) => { answers = rows; render(); });
    }
    render();
  });
  db.onColl("questions", {}, (rows) => { questions = Object.fromEntries(rows.map((r) => [r.id, r])); render(); });
})();
