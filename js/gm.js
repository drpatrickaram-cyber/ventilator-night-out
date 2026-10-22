import { initDB } from "./db.js";
import { h, mount, $, CATS, PTS, TEAM_KEYS, TEAM_COLORS, GAME_TILES, tileId, tileInfo, usedCount, teamName, ranking, secsLeft, staffGate, actions, toast, pageURL, acceptedList } from "./core.js";
import { startReferee } from "./referee.js";

const app = $("#app");
let db, A;
let game = null, signup = {}, questions = {}, answers = [], wallCount = 0;
let ansUnsub = null, ansQid = null;

const run = (fn) => async () => { try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), "bad"); } };
const btn = (label, fn, cls = "", disabled = false, title) => h("button", { class: `btn ${cls}`, onclick: run(fn), disabled, title }, label);

function topBar(g) {
  const ph = (id, label, extra = {}) => btn(label, () => A.setPhase(id, extra), `small phase-btn ${g.phase === id ? "on" : ""}`);
  return h("header", { class: "p-top" },
    h("h1", {}, "Game Master"),
    h("nav", { class: "row", "aria-label": "เปลี่ยนหน้าจอหลัก" },
      ph("lobby", "Lobby"), ph("board", "กระดาน"), ph("end", "จบเกม"), ph("wall", "First Wave"), ph("awards", "Awards")),
    h("div", { class: "sp" }),
    h("a", { class: "btn small ghost", style: { color: "#fff" }, href: pageURL("screen.html"), target: "_blank" }, "จอหลัก ↗"),
    h("a", { class: "btn small ghost", style: { color: "#fff" }, href: pageURL("judge.html"), target: "_blank" }, "กรรมการ ↗"),
    h("a", { class: "btn small ghost", style: { color: "#fff" }, href: pageURL("admin.html"), target: "_blank" }, "Admin ↗"));
}

function teamsCard(g) {
  return h("section", { class: "card" }, h("h2", {}, "คะแนนทีม", g.hideScores ? h("span", { class: "pill" }, "จอหลักซ่อนคะแนนอยู่") : null),
    h("div", { class: "grid3" }, TEAM_KEYS.map((t) => h("div", { class: "teamcard", style: { borderColor: TEAM_COLORS[t] } },
      h("div", { class: "nm" }, h("span", { class: "dot", style: { background: TEAM_COLORS[t] } }), teamName(g, t)),
      h("div", { class: "sc" }, String(g.scores?.[t] ?? 0)),
      h("div", { class: "muted", style: { fontSize: "13px" } }, `Challenge เหลือ ${g.challenges?.[t] ?? 0}`),
      h("div", { class: "row" }, btn("−10", () => A.adjust(t, -10), "small"), btn("+10", () => A.adjust(t, 10), "small"), btn("+1", () => A.adjust(t, 1), "small", false, "+1 (sudden death)"))))));
}

function pickCard(g) {
  const inBoard = g.phase === "board";
  const st = g.buzzWinner
    ? h("div", { class: "big-status win" }, `${teamName(g, g.buzzWinner.team)} ได้สิทธิ์ (${{ phone: "กดมือถือ", key: "ปุ่ม USB", gm: "GM กำหนด", challenge: "CHALLENGE" }[g.buzzWinner.via] || g.buzzWinner.via})`)
    : g.buzzOpen ? h("div", { class: "big-status go" }, "เปิดให้กดอยู่… รอทีมกด") : h("div", { class: "big-status" }, inBoard ? "ถามว่ามีทีมไหน Challenge ไหม แล้วเปิดให้กด" : "สลับจอหลักไปที่ ‘กระดาน’ ก่อน");
  return h("section", { class: "card" }, h("h2", {}, h("span", { class: "n" }, "1"), "หาทีมที่ได้สิทธิ์เลือกช่อง"), st,
    h("div", { class: "row" },
      btn("เปิดให้กด", () => A.openBuzz(), "primary big", !inBoard || !!g.buzzWinner || g.buzzOpen),
      btn("ยกเลิก / เริ่มใหม่", () => A.cancelPick(), "", !g.buzzWinner && !g.buzzOpen)),
    h("div", {}, h("div", { class: "muted", style: { fontSize: "13px", marginBottom: "4px" } }, "Challenge (ทีมชูป้าย)"),
      h("div", { class: "row" }, TEAM_KEYS.map((t) => btn(`${teamName(g, t)} · Challenge`, () => A.challenge(t), "", !inBoard || !!g.buzzWinner || (g.challenges?.[t] ?? 0) <= 0)))),
    h("div", {}, h("div", { class: "muted", style: { fontSize: "13px", marginBottom: "4px" } }, "สำรอง: กริ่งจริง → GM กดเลือกทีมเอง"),
      h("div", { class: "row" }, TEAM_KEYS.map((t) => btn(`กริ่ง ${teamName(g, t)}`, () => A.setWinner(t, "gm", true), "small", !inBoard)))));
}

function boardCard(g) {
  const canPick = g.phase === "board" && !!g.buzzWinner;
  const ended = usedCount(g) >= GAME_TILES;
  return h("section", { class: "card" }, h("h2", {}, h("span", { class: "n" }, "2"), "เลือกช่อง", h("span", { class: "pill" }, `ใช้ไป ${usedCount(g)}/${GAME_TILES}`), g.suddenDeath ? h("span", { class: "pill", style: { background: "#FDECEC" } }, "SUDDEN DEATH") : null),
    h("div", { class: "gboard" },
      CATS.map((c) => h("div", { class: "hd" }, c.short)),
      PTS.flatMap((p) => CATS.map((c) => {
        const id = tileId(c.id, p); const u = g.used?.[id];
        if (u) return h("button", { class: "used", disabled: true, title: id }, `${teamName(g, u.team)} ${u.correct ? "✓" : "✗"} ${u.delta > 0 ? "+" : ""}${u.delta}`);
        const blocked = !canPick || (ended && !g.suddenDeath);
        return h("button", { class: `${g.tile === id ? "sel" : ""} ${questions[id] ? "" : "missing"}`, disabled: blocked, onclick: run(() => A.selectTile(id)), title: questions[id] ? id : `${id} ยังไม่มีโจทย์` }, String(p));
      }))),
    ended && !g.suddenDeath ? h("div", { class: "muted" }, "ครบ 9 ข้อแล้ว → กด ‘จบเกม’ ด้านบน (ถ้าคะแนนเสมอ เปิด Sudden death ด้านขวา)") : null);
}

function questionCard(g) {
  const isQ = g.phase === "question" || g.phase === "reveal";
  const s = isQ ? secsLeft(g, db.now()) : 0;
  return h("section", { class: "card" }, h("h2", {}, h("span", { class: "n" }, "3"), "โจทย์และตัดสิน"),
    h("div", { class: "row" },
      btn("ขึ้นโจทย์บนจอ", () => A.showQuestion(g), "primary big", !(g.phase === "board" && g.tile && g.buzzWinner)),
      h("div", { class: "timer-s", id: "gmtimer", "aria-live": "off" }, isQ && g.ansOpen ? `${s}` : "–"),
      btn("+10 วิ", () => A.addTime(g), "small", !(isQ && g.ansOpen)),
      btn("ปิดรับคำตอบ", () => A.stopAnswers(), "small", !(isQ && g.ansOpen))),
    h("div", { class: "row" },
      btn("✓ ตอบถูก", () => A.judge(g, true), "good big", !(g.phase === "question" && !g.result)),
      btn("✗ ตอบผิด / หมดเวลา", () => A.judge(g, false), "bad big", !(g.phase === "question" && !g.result)),
      btn("↶ ยกเลิกผล", () => A.undoResult(), "small", !g.result || g.phase === "reveal")),
    h("div", { class: "row" },
      btn("เฉลย", () => A.reveal(g), "amber big", !(g.phase === "question" && g.result)),
      btn("กลับกระดาน →", () => A.toBoard(), "primary big", !(g.phase === "reveal" || g.phase === "question"))));
}

function secretCard(g) {
  const id = g.tile || g.qid;
  const q = id ? questions[id] : null;
  const aw = g.audWinner;
  return h("section", { class: "card secret" }, h("h2", {}, "เฉพาะ GM", id ? h("span", { class: "pill" }, id) : null),
    !q ? h("div", { class: "muted" }, id ? "ช่องนี้ยังไม่มีโจทย์ — ใส่ในหน้า Admin" : "เลือกช่องเพื่อดูคำตอบ") :
    h("dl", {},
      h("dt", {}, "โจทย์"), h("dd", {}, q.prompt || "–"),
      h("dt", {}, "คำตอบที่ถูก"), h("dd", { style: { fontWeight: "700" } }, q.answer || "–"),
      h("dt", {}, "เกณฑ์ตัดสินว่าถูก"), h("dd", {}, q.criteria || "–"),
      h("dt", {}, "Pearl ให้ expert"), h("dd", {}, q.pearl || "–"),
      h("dt", {}, `ผู้ชม (${q.aType === "mcq" ? "ปรนัย" : "อัตนัย"})`),
      h("dd", {}, q.aType === "mcq" ? `ข้อถูก: ${q.correct || "?"}` : `คำตอบที่ยอมรับ: ${acceptedList(q).join(", ") || "–"}`)),
    g.qid ? h("div", { class: "row" }, h("span", { class: "pill" }, `ผู้ชมตอบ ${answers.length} คน`),
      h("span", { class: "pill", style: aw ? { background: "#FFE7B8" } : {} }, aw ? `ผู้ชมชนะ: ${aw.name}` : "ยังไม่มีผู้ชนะผู้ชม")) : null);
}

function extrasCard(g) {
  const rk = ranking(g);
  const tie = rk[0].score === rk[1].score || rk[1].score === rk[2].score;
  return h("section", { class: "card" }, h("h2", {}, "Sudden death · First Wave · Awards"),
    h("div", { class: "row" },
      btn(g.suddenDeath ? "ปิด Sudden death" : "เปิด Sudden death", () => db.update("state/game", { suddenDeath: !g.suddenDeath }), g.suddenDeath ? "bad small" : "small"),
      h("span", { class: "muted", style: { fontSize: "13px" } }, tie ? "⚠ ตอนนี้มีคะแนนเสมอ" : "ใช้เมื่อคะแนนเสมอ: ข้อละ 1 คะแนน ไม่หัก")),
    h("div", { class: "row" },
      btn("🚀 Launch สมัครสมาชิก", () => Promise.all([db.set("state/signup", { open: true, launched: true }, true), A.setPhase("wall")]), "amber", signup.open && signup.launched),
      btn(signup.open ? "ปิดฟอร์มสมัคร" : "เปิดฟอร์มสมัคร", () => db.set("state/signup", { open: !signup.open }, true), "small"),
      h("span", { class: "pill" }, `สมาชิก ${wallCount} คน`)),
    h("div", { class: "row" }, [0, 1, 2, 3, 4].map((i) => btn(["หัวข้อ", "ผู้ชม 9 คน", "อันดับ 3", "อันดับ 2", "ชนะเลิศ"][i], () => A.setPhase("awards", { awardsStep: i }), `small phase-btn ${g.phase === "awards" && (g.awardsStep || 0) === i ? "on" : ""}`))),
    h("div", { class: "muted", style: { fontSize: "13px" } }, "อันดับตอนนี้: " + rk.map((r, i) => `${i + 1}. ${r.name} (${r.score})`).join(" · ")));
}

function render() {
  if (!game) {
    mount(app, h("header", { class: "p-top" }, h("h1", {}, "Game Master")),
      h("main", { class: "p-main" }, h("section", { class: "card" }, h("h2", {}, "ยังไม่มีเกม"), h("p", {}, "ไปที่หน้า Admin → ‘เริ่มเกมใหม่’ ก่อน"), h("a", { class: "btn primary", href: pageURL("admin.html") }, "ไปหน้า Admin"))));
    return;
  }
  const g = game;
  const focus = document.activeElement?.textContent;
  mount(app, topBar(g), h("main", { class: "p-main" },
    h("div", { class: "p-col" }, pickCard(g), boardCard(g), questionCard(g)),
    h("div", { class: "p-col" }, secretCard(g), teamsCard(g), extrasCard(g))));
  if (focus) [...app.querySelectorAll("button")].find((b) => b.textContent === focus && !b.disabled)?.focus({ preventScroll: true });
}

setInterval(() => {
  const el = $("#gmtimer");
  if (el && game && (game.phase === "question" || game.phase === "reveal")) el.textContent = game.ansOpen ? String(secsLeft(game, db.now())) : "–";
}, 250);

(async () => {
  db = await initDB();
  await staffGate(db, "Game Master");
  A = actions(db);
  const referee = startReferee(db, A, () => game);
  db.onDoc("state/game", (g) => {
    game = g;
    if (g) {
      referee(g);
      if (g.qid !== ansQid) {
        ansQid = g.qid; if (ansUnsub) ansUnsub(); answers = [];
        if (g.qid) ansUnsub = db.onColl("answers", { where: [["qid", "==", g.qid]] }, (rows) => { answers = rows; render(); });
      }
    }
    render();
  });
  db.onDoc("state/signup", (d) => { signup = d || {}; render(); });
  db.onColl("questions", {}, (rows) => { questions = Object.fromEntries(rows.map((r) => [r.id, r])); render(); });
  db.onColl("wall", {}, (rows) => { wallCount = rows.length; render(); });
})();
