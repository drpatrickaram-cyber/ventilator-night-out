import { initDB } from "./db.js";
import { h, mount, $, TEAM_KEYS, TEAM_COLORS, teamName, staffGate, keepAwake, Sound } from "./core.js";

const app = $("#app");
const snd = new Sound();
let db, game = null, pressedRound = null;
let team = new URLSearchParams(location.search).get("team") || localStorage.getItem("vno-team");
if (!TEAM_KEYS.includes(team)) team = null;

async function press(e) {
  e.preventDefault();
  const pressedAt = db.now(); // capture the moment of the tap before any network call
  snd.unlock();
  let g = game;
  if (!g || !g.buzzOpen) {
    // local view may be stale (dropped connection): double-check with the server
    const fresh = await db.get("state/game").catch(() => null);
    if (fresh) { game = fresh; g = fresh; }
  }
  if (!g || !g.buzzOpen || g.buzzWinner || pressedRound === g.round) { render(); return; }
  pressedRound = g.round;
  navigator.vibrate?.(60);
  render();
  try { await db.create(`buzz/${g.round}_${team}`, { round: g.round, team, pressedAt, at: db.TS }); }
  catch (err) { console.warn(err); }
}

function render() {
  if (!team) {
    mount(app, h("div", { class: "pick" }, h("div", { class: "kicker" }, "THE VENTILATOR GAMES"), h("h1", {}, "เครื่องนี้เป็นปุ่มของทีมไหน?"),
      TEAM_KEYS.map((t) => h("button", { class: "btn big", style: { background: TEAM_COLORS[t], color: "#fff", borderColor: TEAM_COLORS[t] }, onclick: () => { team = t; localStorage.setItem("vno-team", t); render(); } }, teamName(game, t)))));
    return;
  }
  const g = game;
  let cls = "", label = "รอสัญญาณ", msg = "รอ Game Master เปิดให้กด";
  if (g?.buzzWinner) {
    if (g.buzzWinner.team === team) { cls = "won"; label = "ได้สิทธิ์!"; msg = g.buzzWinner.via === "challenge" ? "Challenge — เลือกช่องได้เลย" : "ทีมคุณกดได้ก่อน เลือกช่องได้เลย"; }
    else { cls = "lost"; label = "ช้าไป"; msg = `${teamName(g, g.buzzWinner.team)} ได้สิทธิ์`; }
  } else if (g?.buzzOpen) {
    if (pressedRound === g.round) { cls = "go"; label = "ส่งแล้ว…"; msg = "กำลังตัดสิน"; }
    else { cls = "go"; label = "กด!"; msg = "กดเลย!"; }
  }
  const b = h("button", { class: `bz ${cls}`, style: cls === "" ? { background: "#34495E" } : {}, "aria-label": `ปุ่มกดของ ${teamName(g, team)}` }, label);
  b.addEventListener("pointerdown", press);
  b.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") press(e); });
  mount(app,
    h("div", { class: "bz-top" },
      h("div", { class: "bz-team" }, h("span", { class: "dot", style: { background: TEAM_COLORS[team], width: "16px", height: "16px" } }), teamName(g, team)),
      h("button", { class: "btn small ghost", style: { color: "#fff" }, onclick: () => { if (confirm("เปลี่ยนทีมของเครื่องนี้?")) { team = null; localStorage.removeItem("vno-team"); render(); } } }, "เปลี่ยนทีม")),
    h("div", { class: "bz-wrap" }, b),
    h("div", { class: "bz-msg", role: "status" }, msg));
}

(async () => {
  db = await initDB();
  await staffGate(db, "ปุ่มกดทีม");
  keepAwake();
  db.onDoc("state/game", (g) => {
    const won = g?.buzzWinner && !game?.buzzWinner && g.buzzWinner.team === team;
    game = g;
    if (won) { navigator.vibrate?.([80, 60, 80]); snd.ding(); }
    render();
  });
})();
