import { initDB } from "./db.js";
import { h, mount, $, CATS, PTS, TEAM_KEYS, TEAM_COLORS, GAME_TILES, tileId, tileInfo, usedCount, teamName, ranking, qrSVG, pageURL, secsLeft, Sound, staffGate, actions, keepAwake, fmtMs } from "./core.js";
import { startReferee } from "./referee.js";

const stage = $("#stage");
const snd = new Sound();
let db, A;
let game = null, cur = null, img = null, rev = null, players = [], answers = [], wall = [], signup = {};
let prev = {};
let ansUnsub = null, ansQid = null;

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener("resize", fit); fit();

$("#start").addEventListener("click", () => {
  snd.unlock();
  document.documentElement.requestFullscreen?.().catch(() => {});
  $("#start").remove();
  keepAwake();
});

const traceSVG = () => {
  const pts = [];
  for (let x = 0; x <= 1920; x += 6) {
    const t = (x / 480) % 1;
    const y = t < 0.04 ? 170 - 3000 * t : t < 0.33 ? 50 : t < 0.37 ? 50 + 3000 * (t - 0.33) : 170;
    pts.push(`${x},${Math.min(170, Math.max(50, y))}`);
  }
  const s = h("div", { class: "trace", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 1920 220" width="1920" height="220"><polyline points="${pts.join(" ")}" fill="none" stroke="#18B5CB" stroke-width="5" stroke-linejoin="round"/></svg>`;
  return s;
};

function teamBar(g, activeTeam) {
  return h("div", { class: "teams" }, TEAM_KEYS.map((t) =>
    h("div", { class: `team ${activeTeam === t ? "active" : ""}` },
      h("div", { class: "sw", style: { background: TEAM_COLORS[t] } }),
      h("div", {},
        h("div", { class: "nm" }, teamName(g, t)),
        h("div", { class: "ch" }, "Challenge", [0, 1].map((i) => h("span", { class: `pip ${(g.challenges?.[t] ?? 0) > i ? "on" : ""}` })))),
      h("div", { class: "sc" }, g.hideScores ? "?" : String(g.scores?.[t] ?? 0)))));
}

function viewLobby(g) {
  const url = pageURL("index.html");
  const qr = h("div", { class: "lobby-qr" }); qr.innerHTML = qrSVG(url);
  return h("div", { class: "s-wrap" },
    h("div", { class: "s-kicker" }, "VENTILATOR NIGHT OUT · THE FIRST WAVE"),
    h("div", { class: "s-row", style: { flex: "1", alignItems: "center" } },
      h("div", { class: "s-grow", style: { display: "flex", flexDirection: "column", gap: "28px" } },
        h("div", { class: "s-title" }, "The Ventilator Games"),
        h("div", { class: "s-sub" }, "ผู้ชมร่วมเล่นได้ทุกข้อ · ตอบถูกเร็วที่สุดรับรางวัล ข้อละ 1 คน"),
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "24px" } },
          h("div", { class: "big-count" }, String(players.length)), h("div", { class: "s-sub" }, "คนเข้าร่วมแล้ว"))),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "16px", alignItems: "center" } },
        qr, h("div", { class: "s-sub", style: { fontSize: "34px" } }, "สแกนเพื่อร่วมเล่น"))),
    teamBar(g, null), traceSVG());
}

function statusLine(g) {
  if (g.buzzWinner) {
    const via = g.buzzWinner.via === "challenge" ? " · CHALLENGE!" : "";
    return h("div", { class: "status win" }, `${teamName(g, g.buzzWinner.team)} ได้สิทธิ์เลือกช่อง${via}`);
  }
  if (g.buzzOpen) return h("div", { class: "status go" }, "กดได้เลย!");
  const n = usedCount(g);
  return h("div", { class: "status" }, n >= GAME_TILES ? "ครบ 9 ข้อแล้ว" : `ข้อที่ ${n + 1} จาก ${GAME_TILES} · มีทีมไหน Challenge ไหม?`);
}

function viewBoard(g) {
  const board = h("div", { class: "board" },
    CATS.map((c) => h("div", { class: "cat" }, c.full.split(" ")[0] === "Waveform" ? ["Waveform", h("small", {}, "Fast & Furious")] : c.id === "SD" ? ["Setting", h("small", {}, "Disaster")] : ["Monitor", h("small", {}, "Mayhem")])),
    PTS.flatMap((p) => CATS.map((c) => {
      const id = tileId(c.id, p);
      const u = g.used?.[id];
      if (u) {
        const label = g.hideScores ? teamName(g, u.team) : `${teamName(g, u.team)} ${u.correct ? "✓" : "✗"}`;
        return h("div", { class: "tile used", style: { borderColor: TEAM_COLORS[u.team] } }, p, h("div", { class: "res" }, label));
      }
      return h("div", { class: `tile ${g.tile === id ? "sel" : ""}` }, String(p));
    })));
  return h("div", { class: "s-wrap", style: { gap: "24px" } }, teamBar(g, g.buzzWinner?.team), statusLine(g), board);
}

function timerEl(g) {
  const s = secsLeft(g, db.now());
  const open = g.ansOpen && !g.result;
  return h("div", { class: `timer ${!open || s === 0 ? "done" : s <= 5 ? "low" : ""}`, id: "timer" }, open ? String(s) : "–");
}

function viewQuestion(g) {
  if (!cur || cur.qid !== g.qid) return h("div", { class: "s-wrap" }, h("div", { class: "s-sub" }, "กำลังโหลดโจทย์…"));
  const info = tileInfo(cur.qid);
  const team = g.buzzWinner?.team;
  const hasImg = cur.hasImg && img?.qid === cur.qid && img.data;
  const isRev = g.phase === "reveal";
  const head = h("div", { class: "q-head" },
    h("span", { class: "chip" }, info.catObj.full),
    h("span", { class: "chip pts" }, cur.sd ? "Sudden death" : `${info.pts} คะแนน`),
    team && h("span", { class: "chip team", style: { background: TEAM_COLORS[team] } }, `${teamName(g, team)} ตอบ${g.buzzWinner.via === "challenge" ? " · CHALLENGE" : ""}`));
  const opts = cur.aType === "mcq" && cur.options?.length ? h("div", { class: "opts" }, cur.options.map((o, i) => {
    const L = "ABCD"[i];
    return h("div", { class: `opt ${isRev && rev?.qid === cur.qid && rev.correctOption === L ? "right" : ""}` }, h("b", {}, L), o);
  })) : null;
  const textCol = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", gap: "28px", justifyContent: "center" } },
    h("div", { class: "q-text", style: hasImg ? { fontSize: "46px", flex: "0 0 auto" } : {} }, cur.prompt), opts);
  const body = h("div", { class: "q-body" }, textCol,
    hasImg && h("div", { class: "q-img" }, h("img", { src: img.data, alt: "ภาพประกอบโจทย์" })),
    !isRev && h("div", { class: "q-side" }, timerEl(g), h("div", { class: "ans-count" }, "ผู้ชมตอบแล้ว", h("b", { id: "anscount" }, String(answers.length)), "คน")));
  const kids = [head, body];
  if (isRev) kids.push(revealBlock(g));
  const wrap = h("div", { class: "s-wrap" }, kids);
  if (g.result && !isRev) {
    const r = g.result;
    const msg = g.hideScores ? "บันทึกผลแล้ว" : `${r.delta > 0 ? "+" : ""}${r.delta} คะแนน · ${teamName(g, r.team)}`;
    wrap.appendChild(h("div", { class: `verdict ${r.correct ? "ok" : "no"}` }, h("div", { class: "v" }, r.correct ? "ถูกต้อง!" : "ไม่ถูก", h("small", {}, msg))));
  }
  return wrap;
}

function revealBlock(g) {
  const r = rev?.qid === g.qid ? rev : null;
  const aw = g.audWinner;
  const audEl = aw
    ? h("div", { class: "aud" }, h("div", { class: "bolt", "aria-hidden": "true" }, "⚡"),
        h("div", {}, h("div", { class: "meta" }, "ผู้ชมที่ตอบถูกเร็วที่สุด"), h("div", { class: "who" }, aw.name), h("div", { class: "meta" }, [aw.inst, aw.ms != null ? fmtMs(aw.ms) : ""].filter(Boolean).join(" · "))))
    : h("div", { class: "aud wait" }, h("div", { class: "meta" }, cur?.aType === "open" ? "กรรมการกำลังตรวจคำตอบผู้ชม…" : "ไม่มีผู้ชมตอบถูกในข้อนี้"));
  const resLine = g.result && !g.hideScores ? h("div", { class: "s-sub" }, `${teamName(g, g.result.team)} ${g.result.correct ? "ตอบถูก" : "ตอบไม่ถูก"} · ${g.result.delta > 0 ? "+" : ""}${g.result.delta} คะแนน`) : null;
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "22px" } },
    h("div", { class: "rev-ans" }, h("span", { class: "lbl" }, "เฉลย"), r ? r.answerShort : "…"), resLine, audEl);
}

function viewEnd(g) {
  return h("div", { class: "s-wrap" },
    h("div", { class: "s-kicker" }, "THE VENTILATOR GAMES"),
    h("div", { style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "center", gap: "30px" } },
      h("div", { class: "s-title" }, "จบเกม!"),
      h("div", { class: "s-sub" }, "คะแนนรวมสุดท้ายจะประกาศตอนมอบรางวัล")),
    teamBar({ ...g, hideScores: true }, null), traceSVG());
}

function viewWall() {
  const url = pageURL("index.html", { signup: "1" });
  const qr = h("div", { class: "lobby-qr", style: { width: "360px", height: "360px" } }); qr.innerHTML = qrSVG(url);
  const latest = [...wall].sort((a, b) => b.at - a.at).slice(0, 7);
  const open = signup.open;
  return h("div", { class: "s-wrap" },
    h("div", { class: "s-kicker" }, "MECHANICAL VENTILATOR ASSEMBLY · FOUNDING MEMBERS"),
    h("div", { class: "s-row", style: { flex: "1", alignItems: "stretch" } },
      h("div", { style: { width: "620px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "24px" } },
        h("div", { class: "s-sub" }, "Be the First Wave"),
        h("div", { class: "wall-count", id: "wallcount" }, String(wall.length).padStart(3, "0")),
        h("div", { class: "s-sub" }, "สมาชิกผู้ก่อตั้ง")),
      h("div", { class: "s-grow wall-list", style: { justifyContent: "center" } },
        latest.length ? latest.map((w, i) => h("div", { class: `wall-item ${i === 0 ? "new" : ""}` }, h("span", {}, w.name), h("span", { class: "inst" }, w.inst || "")))
          : h("div", { class: "s-sub" }, open ? "รอสมาชิกคนแรก…" : "เร็ว ๆ นี้")),
      h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px" } },
        open ? qr : null, open ? h("div", { class: "s-sub", style: { fontSize: "32px" } }, "สแกนเพื่อสมัคร") : null)),
    traceSVG());
}

function viewAwards(g) {
  const step = g.awardsStep || 0;
  const head = h("div", { class: "s-kicker" }, "AWARDS · THE VENTILATOR GAMES");
  if (step === 0) return h("div", { class: "s-wrap" }, head, h("div", { style: { flex: "1", display: "grid", placeItems: "center" } }, h("div", { class: "s-title" }, "ประกาศรางวัล")), traceSVG());
  if (step === 1) {
    const list = Object.entries(g.audWinners || {}).filter(([, w]) => w).sort(([a], [b]) => a.localeCompare(b));
    return h("div", { class: "s-wrap" }, head, h("div", { class: "s-title", style: { fontSize: "72px" } }, `ผู้ชมที่ตอบถูกเร็วที่สุด ${list.length} คน`),
      h("div", { class: "aw-grid" }, list.map(([qid, w]) => h("div", { class: "aw-card" },
        h("div", { class: "q" }, `${tileInfo(qid).catObj.short} ${tileInfo(qid).pts}`), h("div", { class: "n" }, w.name), h("div", { class: "i" }, w.inst || "")))));
  }
  const rk = ranking(g);
  const prize = ["3,000 บาท", "2,400 บาท", "1,500 บาท"];
  const order = [1, 0, 2]; // podium: 2nd, 1st, 3rd
  const heights = { 0: "640px", 1: "520px", 2: "430px" };
  const shown = (i) => (i === 2 && step >= 2) || (i === 1 && step >= 3) || (i === 0 && step >= 4);
  return h("div", { class: "s-wrap" }, head,
    h("div", { class: "podium" }, order.map((i) => {
      const r = rk[i]; const vis = shown(i);
      return h("div", { class: `pod ${vis ? "" : "hide"}`, style: { height: heights[i], background: vis ? TEAM_COLORS[r.t] : "" } },
        h("div", { class: "rk" }, ["ชนะเลิศ", "รองชนะเลิศ", "อันดับ 3"][i]),
        vis && h("div", { class: "nm" }, r.name), vis && h("div", { class: "sc" }, String(r.score)), vis && h("div", { class: "pr" }, prize[i]));
    })));
}

function render() {
  if (!game) { mount(stage, h("div", { class: "s-wrap" }, h("div", { class: "s-sub" }, "รอ admin ตั้งค่าเกม…"))); return; }
  const g = game;
  const v = { lobby: viewLobby, board: viewBoard, question: viewQuestion, reveal: viewQuestion, end: viewEnd, wall: viewWall, awards: viewAwards }[g.phase] || viewLobby;
  mount(stage, v(g));
}

function sounds(g) {
  const p = prev;
  if (g.buzzWinner && !p.buzzWinner) snd.buzz();
  if (g.result && !p.result) g.result.correct ? snd.correct() : snd.wrong();
  if (g.phase === "reveal" && p.phase !== "reveal") snd.reveal();
  if (g.audWinner && !p.audWinner && g.phase === "reveal") snd.ding();
  if (g.phase === "awards" && (g.awardsStep || 0) !== (p.awardsStep || 0)) (g.awardsStep >= 4 ? snd.fanfare() : snd.reveal());
  prev = JSON.parse(JSON.stringify(g));
}

let lastTick = null;
setInterval(() => {
  if (!game || game.phase !== "question") return;
  const t = $("#timer");
  if (!t) return;
  const s = secsLeft(game, db.now());
  const open = game.ansOpen && !game.result;
  t.textContent = open ? String(s) : "–";
  t.className = `timer ${!open || s === 0 ? "done" : s <= 5 ? "low" : ""}`;
  if (open && s <= 5 && s > 0 && s !== lastTick) { snd.tick(); }
  lastTick = s;
}, 200);

addEventListener("keydown", (e) => {
  if (!game || !A) return;
  const k = { "1": "t1", "2": "t2", "3": "t3" }[e.key];
  if (k && game.buzzOpen && !game.buzzWinner) A.setWinner(k, "key");
  if (e.key === "f") document.documentElement.requestFullscreen?.();
});

(async () => {
  db = await initDB();
  await staffGate(db, "จอหลัก");
  A = actions(db);
  const referee = startReferee(db, A, () => game);
  db.onDoc("state/game", (g) => {
    game = g;
    if (g) {
      referee(g);
      if (g.qid !== ansQid) {
        ansQid = g.qid; if (ansUnsub) ansUnsub(); answers = [];
        if (g.qid) ansUnsub = db.onColl("answers", { where: [["qid", "==", g.qid]] }, (rows) => { answers = rows; const el = $("#anscount"); if (el) el.textContent = String(rows.length); });
      }
      sounds(g);
    }
    render();
  });
  db.onDoc("pub/current", (d) => { cur = d; render(); });
  db.onDoc("pub/img", (d) => { img = d; render(); });
  db.onDoc("pub/reveal", (d) => { rev = d; render(); });
  db.onDoc("state/signup", (d) => { signup = d || {}; if (game?.phase === "wall") render(); });
  db.onColl("players", {}, (rows) => { players = rows; if (game?.phase === "lobby") render(); });
  db.onColl("wall", {}, (rows) => { if (rows.length > wall.length && game?.phase === "wall") snd.ding(); wall = rows; if (game?.phase === "wall") render(); });
})();
