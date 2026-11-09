// Projector screen: read-only view of the public docs. No PIN needed.
import { initDB } from "./db.js";
import { h, mount, $, P, remainingMs, fmtSec, nf, qrSVG, pageURL, prettyURL, Sound, keepAwake } from "./core.js";

const stage = $("#stage");
const sound = new Sound();
let db, state = null, pub = null, board = null, config = {}, counts = {};
let viewKey = "", lastPhase = null, lastSec = -1, lastStep = -1;
const joinURL = pageURL("index.html");
const QR = qrSVG(joinURL);
const TRACE = '<svg class="s-trace" viewBox="0 0 1600 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0 70 H180 L200 18 H330 L345 70 H560 L580 18 H710 L725 70 H940 L960 18 H1090 L1105 70 H1320 L1340 18 H1470 L1485 70 H1600" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';

startOverlay();
boot();

function startOverlay() {
  const go = () => { sound.unlock(); document.documentElement.requestFullscreen?.().catch(() => {}); ov.remove(); keepAwake(); };
  const ov = h("div", { class: "s-start" }, h("div", {},
    h("button", { type: "button", onclick: go }, "คลิกเพื่อเริ่มจอหลัก"),
    h("p", {}, "เปิดเสียงและเต็มจอ · กด F เพื่อสลับเต็มจอ")));
  document.body.appendChild(ov);
  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  });
}

async function boot() {
  db = await initDB();
  db.onDoc(P.config, (d) => { config = d || {}; viewKey = ""; render(); });
  db.onDoc(P.pub, (d) => { pub = d; render(); });
  db.onDoc(P.board, (d) => { board = d; render(); });
  db.onDoc(P.state, (d) => { state = d; render(); });
  db.onDoc(P.counts, (d) => { counts = d || {}; render(); });
  tick();
}

function render() {
  const phase = state?.phase || "lobby";
  // live counters update in place instead of re-rendering
  const pc = document.getElementById("pcount"); if (pc) pc.textContent = nf(counts.players || 0);
  const ac = document.getElementById("acount"); if (ac) ac.textContent = nf(answeredNow());
  const key = [phase, state?.qid, pub?.qid, state?.reveal?.qid, state?.reveal?.winner?.uid, state?.reveal?.correctN, board?.v, state?.finalStep, config.title].join("|");
  if (key !== viewKey) {
    viewKey = key;
    let body;
    if (phase === "question" || phase === "closed") body = pub?.qid === state.qid ? questionView(phase) : h("div");
    else if (phase === "reveal") body = revealView();
    else if (phase === "board") body = boardView();
    else if (phase === "final") body = finalView();
    else body = lobbyView();
    const showJoin = phase !== "lobby" && phase !== "final";
    mount(stage,
      h("header", { class: "s-top" },
        h("p", { class: "s-brand", html: `<b>${escapeHTML(config.title || "The Ventilator Games")}</b> · ร่วมตอบจากมือถือ` }),
        h("p", { class: "s-count" }, "ผู้ร่วมเล่น ", h("b", { id: "pcount" }, nf(counts.players || 0)), " คน")),
      h("main", { class: "s-body s-fade" }, body),
      h("footer", { class: "s-foot" },
        showJoin ? h("div", { class: "s-join" }, h("div", { class: "qr", html: QR }), h("div", {}, "ยังไม่ได้เข้าร่วม? สแกนเลย", h("br"), h("b", {}, prettyURL(joinURL)))) : h("span"),
        h("span")),
      h("div", { html: TRACE }));
  }
  sounds(phase);
}

function sounds(phase) {
  if (phase !== lastPhase) {
    if (phase === "question") sound.open();
    if (phase === "closed") sound.stop();
    if (phase === "reveal") sound.reveal();
    lastPhase = phase;
  }
  const step = phase === "final" ? state?.finalStep || 0 : -1;
  if (step !== lastStep) { if (step === 3) sound.fanfare(); else if (step > 0) sound.reveal(); lastStep = step; }
}

const answeredNow = () => (counts.qid && counts.qid === state?.qid ? counts.answered || 0 : 0);
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function lobbyView() {
  return h("section", { class: "s-lobby" },
    h("div", {},
      h("p", { class: "s-kicker" }, config.title || "The Ventilator Games"),
      h("h1", { class: "s-h1" }, "ร่วมตอบไปพร้อมกับทีมบนเวที"),
      h("div", { class: "s-steps" },
        h("div", { class: "s-step" }, h("i", {}, "1"), "สแกน QR ด้วยกล้องมือถือ"),
        h("div", { class: "s-step" }, h("i", {}, "2"), "ใส่ชื่อและสถาบัน"),
        h("div", { class: "s-step" }, h("i", {}, "3"), "พิมพ์คำตอบให้ถูกและเร็วที่สุด")),
      h("div", { class: "s-big-count" }, h("strong", { id: "pcount2" }, nf(counts.players || 0)), h("span", {}, "คนเข้าร่วมแล้ว"))),
    h("div", { class: "s-qr-card" }, h("div", { class: "qr", html: QR }), h("p", { class: "s-url" }, prettyURL(joinURL))));
}

function questionView(phase) {
  const long = (pub.text || "").length > 140;
  return h("section", { class: `s-q${pub.img ? " has-img" : ""}` },
    pub.img ? h("div", { class: "s-q-img" }, h("img", { src: pub.img, alt: "ภาพโจทย์" })) : null,
    h("div", { class: "s-q-side" },
      h("p", { class: "s-kicker" }, `ข้อ ${pub.no}${pub.label ? " · " + pub.label : ""}`),
      pub.text ? h("p", { class: `s-q-text${long ? " long" : ""}` }, pub.text) : null,
      h("div", { class: "s-timer" },
        h("span", { class: `s-clock${phase === "closed" ? " done" : ""}`, id: "clock" }, phase === "closed" ? "หมดเวลา" : ""),
        phase === "question" ? h("div", { class: "s-bar", id: "bar" }, h("i", {})) : null),
      h("p", { class: "s-answered" }, "ส่งคำตอบแล้ว ", h("b", { id: "acount" }, nf(answeredNow())), " คน")));
}

function miniBoard(n, title) {
  const rows = (board?.top || []).slice(0, n);
  if (!rows.length) return null;
  return h("div", { class: "s-lb" }, h("h2", {}, title),
    rows.map((r, i) => h("div", { class: `s-row${i === 0 ? " r1" : ""}`, style: { animationDelay: `${i * 70}ms` } },
      h("span", { class: "rk" }, String(i + 1)),
      h("span", { class: "nm" }, h("strong", {}, r.name), h("span", {}, r.inst)),
      h("span", { class: "sc" }, nf(r.score)))));
}

function revealView() {
  const rv = state?.reveal;
  if (!rv || rv.qid !== state.qid) return h("div");
  const w = rv.winner;
  return h("section", { class: "s-reveal" },
    h("div", {},
      h("p", { class: "s-kicker" }, `เฉลย ข้อ ${pub?.qid === rv.qid ? pub.no : ""}`),
      h("p", { class: `s-ans${(rv.answer || "").length > 40 ? " long" : ""}` }, rv.answer || "—"),
      w ? h("div", { class: "s-winner" }, h("span", {}, "ตอบถูกเร็วที่สุด"), h("strong", {}, w.name), h("em", {}, `${w.inst} · ${fmtSec(w.ms)} วินาที`))
        : h("div", { class: "s-winner none" }, h("span", {}, "ข้อนี้ยังไม่มีผู้ชมตอบถูก")),
      h("p", { class: "s-ratio" }, "ตอบถูก ", h("b", {}, nf(rv.correctN)), ` จาก ${nf(rv.answered)} คน`)),
    miniBoard(5, "คะแนนรวม 5 อันดับแรก"));
}

function boardView() {
  const rows = (board?.top || []).slice(0, 10);
  const row = (r, i) => h("div", { class: `s-row${i === 0 ? " r1" : ""}`, style: { animationDelay: `${i * 60}ms` } },
    h("span", { class: "rk" }, String(i + 1)),
    h("span", { class: "nm" }, h("strong", {}, r.name), h("span", {}, r.inst)),
    h("span", { class: "sc" }, nf(r.score)));
  return h("section", { class: "s-lb full" },
    h("p", { class: "s-kicker" }, `คะแนนรวม หลัง ${board?.done || 0} ข้อ`),
    h("h1", { class: "s-h1", style: { fontSize: "3.4rem", marginBottom: "1.2rem" } }, "ตารางคะแนนผู้ชม"),
    rows.length ? h("div", { class: "two" }, rows.map(row)) : h("p", { class: "s-lead" }, "ยังไม่มีคะแนน"));
}

function finalView() {
  const step = state?.finalStep || 0;
  if (step === 0) {
    const ws = board?.winners || [];
    return h("section", { class: "s-final" },
      h("p", { class: "s-kicker" }, "รางวัลรายข้อ"),
      h("h1", { class: "s-h1", style: { fontSize: "3.4rem" } }, "ผู้ตอบถูกเร็วที่สุดแต่ละข้อ"),
      ws.length ? h("div", { class: "s-winners" }, ws.map((w, i) => h("div", { class: "s-wcard", style: { animationDelay: `${i * 90}ms` } },
        h("span", {}, `ข้อ ${w.no}${w.label ? " · " + w.label : ""}`), h("strong", {}, w.name), h("em", {}, `${w.inst} · ${fmtSec(w.ms)} วิ`))))
        : h("p", { class: "s-lead" }, "ยังไม่มีผู้ได้รางวัลรายข้อ"));
  }
  const top = board?.top || [];
  const pod = (place) => {
    const r = top[place - 1];
    const shown = step >= 4 - place; // step1 → 3rd, step2 → 2nd, step3 → 1st
    return h("div", { class: `s-pod p${place} ${shown ? "show" : "hide"}` },
      h("div", { class: "who" }, r ? [h("strong", {}, r.name), h("span", {}, r.inst), h("em", {}, `${nf(r.score)} คะแนน`)] : h("span", {}, "—")),
      h("div", { class: "blk" }, String(place)));
  };
  return h("section", { class: "s-final" },
    h("p", { class: "s-kicker" }, "คะแนนรวมสูงสุด"),
    h("h1", { class: "s-h1", style: { fontSize: "3.4rem" } }, step >= 3 ? "ยินดีด้วย!" : "ใครจะเป็นแชมป์ผู้ชม?"),
    h("div", { class: "s-podium" }, pod(2), pod(1), pod(3)));
}

function tick() {
  const clock = document.getElementById("clock");
  const bar = document.getElementById("bar");
  if (state?.phase === "question" && clock && bar && db) {
    const ms = remainingMs(state, db.now());
    const s = Math.ceil(ms / 1000);
    if (s !== lastSec) {
      lastSec = s; clock.textContent = String(s);
      clock.classList.toggle("low", s <= 5); bar.classList.toggle("low", s <= 5);
      if (s <= 5 && s > 0) sound.tick();
    }
    bar.firstChild.style.transform = `scaleX(${ms / ((state.secs || 30) * 1000)})`;
  }
  const pc2 = document.getElementById("pcount2"); if (pc2) pc2.textContent = nf(counts.players || 0);
  requestAnimationFrame(tick);
}
