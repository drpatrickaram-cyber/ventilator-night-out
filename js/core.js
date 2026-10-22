// Shared helpers, constants and game actions.
import qrcode from "./vendor/qrcode.mjs";

export const CATS = [
  { id: "WF", short: "Waveform", full: "Waveform Fast & Furious" },
  { id: "SD", short: "Setting", full: "Setting Disaster" },
  { id: "MM", short: "Monitor", full: "Monitor Mayhem" },
];
export const PTS = [10, 20, 30, 40];
export const TEAM_KEYS = ["t1", "t2", "t3"];
export const TEAM_COLORS = { t1: "#18B5CB", t2: "#F0525B", t3: "#9277FF" };
export const GAME_TILES = 9;
export const ANSWER_SECS = 30;
export const tileId = (cat, pts) => `${cat}${pts}`;
export const tileInfo = (id) => ({ cat: id.slice(0, 2), pts: +id.slice(2), catObj: CATS.find((c) => c.id === id.slice(0, 2)) });
export const ALL_TILES = CATS.flatMap((c) => PTS.map((p) => tileId(c.id, p)));

// ---------- DOM ----------
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export function mount(root, ...kids) { root.replaceChildren(...kids.flat(Infinity).filter(Boolean)); }
export function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

export function toast(msg, kind = "") {
  let box = $("#toasts");
  if (!box) { box = h("div", { id: "toasts" }); document.body.appendChild(box); }
  const t = h("div", { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- URLs ----------
export function pageURL(page, params = {}) {
  const u = new URL(page, location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (sessionStorage.getItem("vno-dev") === "1") u.searchParams.set("dev", "1");
  return u.toString();
}
export function qrSVG(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}

// ---------- text matching (open answers) ----------
export function norm(s) {
  return String(s || "").normalize("NFC").toLowerCase().replace(/[\s\-_.·,/()'"’]+/g, "");
}
export function acceptedList(q) {
  return String(q?.accepted || "").split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
}
export function isMatch(text, accepted) {
  const t = norm(text);
  if (!t) return false;
  return accepted.some((a) => { const n = norm(a); return n && (t === n || (n.length >= 4 && t.includes(n))); });
}

// ---------- time ----------
export function secsLeft(game, now) {
  if (!game?.qOpenedAt) return 0;
  const end = game.qOpenedAt + (game.ansSecs || ANSWER_SECS) * 1000;
  return Math.max(0, Math.ceil((end - now) / 1000));
}
export const fmtMs = (ms) => (ms / 1000).toFixed(2) + " วิ";

// ---------- sound (synthesised; no files) ----------
export class Sound {
  constructor() { this.ctx = null; this.on = true; }
  unlock() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ctx.resume(); }
  get ready() { return this.ctx && this.ctx.state === "running"; }
  tone(freq, dur, type = "sine", vol = 0.25, when = 0) {
    if (!this.on || !this.ready) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  buzz() { this.tone(180, 0.5, "square", 0.22); this.tone(240, 0.5, "square", 0.12); }
  tick() { this.tone(1000, 0.08, "sine", 0.15); }
  correct() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.25, "triangle", 0.22, i * 0.09)); }
  wrong() { this.tone(160, 0.6, "sawtooth", 0.18); this.tone(120, 0.6, "sawtooth", 0.12, 0.05); }
  reveal() { [392, 523].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.2, i * 0.12)); }
  fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.24, i * 0.14)); }
  ding() { this.tone(1320, 0.25, "sine", 0.18); }
}

export async function keepAwake() {
  try { if ("wakeLock" in navigator) { let l = await navigator.wakeLock.request("screen"); document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible") l = await navigator.wakeLock.request("screen"); }); } } catch (e) { /* not supported */ }
}

// ---------- staff gate (6-digit PIN) ----------
export async function staffGate(db, title) {
  const mine = await db.get(`staff/${db.uid}`).catch(() => null);
  if (mine) return true;
  return new Promise((resolve) => {
    const input = h("input", { type: "password", inputmode: "numeric", maxlength: "6", autocomplete: "off", placeholder: "••••••", "aria-label": "PIN 6 หลัก", class: "pin-input" });
    const msg = h("p", { class: "pin-msg", role: "alert" });
    const go = async (e) => {
      e?.preventDefault();
      const pin = input.value.trim();
      if (!/^\d{6}$/.test(pin)) { msg.textContent = "กรุณาใส่ PIN 6 หลัก"; return; }
      try {
        await db.create(`staff/${db.uid}`, { pin, at: db.TS, page: title });
        overlay.remove(); resolve(true);
      } catch (err) { msg.textContent = "PIN ไม่ถูกต้อง"; input.value = ""; input.focus(); }
    };
    const overlay = h("div", { class: "gate" },
      h("form", { class: "gate-card", onsubmit: go },
        h("div", { class: "kicker" }, "VENTILATOR NIGHT OUT · STAFF"),
        h("h1", {}, title),
        h("label", { for: "pin" }, "ใส่ PIN ทีมงาน"),
        input, msg,
        h("button", { type: "submit", class: "btn primary big" }, "เข้าสู่ระบบ")));
    input.id = "pin";
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------- CSV ----------
export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
}
export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("th-TH", { hour12: false }) : "");

// ---------- game model ----------
export function newGame(teams) {
  return {
    phase: "lobby",
    teams: teams || { t1: { name: "ทีม 1" }, t2: { name: "ทีม 2" }, t3: { name: "ทีม 3" } },
    scores: { t1: 0, t2: 0, t3: 0 },
    challenges: { t1: 2, t2: 2, t3: 2 },
    used: {},
    round: 0,
    buzzOpen: false, buzzOpenedAt: null, buzzWinner: null,
    tile: null, qid: null, ansOpen: false, qOpenedAt: null, ansSecs: ANSWER_SECS,
    result: null, revealed: false,
    audWinner: null, audWinners: {},
    hideScores: false, suddenDeath: false, awardsStep: 0,
  };
}
export const usedCount = (g) => Object.values(g?.used || {}).filter((u) => !u.sd).length;
export const teamName = (g, t) => g?.teams?.[t]?.name || t;
export function ranking(g) {
  return TEAM_KEYS.map((t) => ({ t, name: teamName(g, t), score: g.scores?.[t] || 0 })).sort((a, b) => b.score - a.score);
}

// Game actions — used by GM panel, screen (keyboard) and referee.
export function actions(db) {
  const G = "state/game";
  const A = {
    async openBuzz() {
      await db.update(G, { buzzOpen: true, buzzOpenedAt: db.TS, buzzWinner: null, round: db.inc(1), tile: null });
    },
    async closeBuzz() { await db.update(G, { buzzOpen: false }); },
    async setWinner(team, via, force = false) {
      return db.tx(G, (g) => {
        if (!g) return null;
        if (!force && (g.buzzWinner || !g.buzzOpen)) return null;
        return { buzzWinner: { team, via, at: db.now() }, buzzOpen: false };
      });
    },
    async challenge(team) {
      return db.tx(G, (g) => {
        if (!g || (g.challenges?.[team] ?? 0) <= 0) return null;
        const p = { buzzWinner: { team, via: "challenge", at: db.now() }, buzzOpen: false, tile: null };
        p[`challenges.${team}`] = g.challenges[team] - 1;
        if (g.buzzWinner?.via === "challenge" && g.buzzWinner.team !== team) p[`challenges.${g.buzzWinner.team}`] = (g.challenges[g.buzzWinner.team] || 0) + 1;
        return p;
      });
    },
    async cancelPick() {
      return db.tx(G, (g) => {
        if (!g?.buzzWinner) return { buzzOpen: false, tile: null };
        const p = { buzzWinner: null, buzzOpen: false, tile: null };
        if (g.buzzWinner.via === "challenge") p[`challenges.${g.buzzWinner.team}`] = (g.challenges[g.buzzWinner.team] || 0) + 1;
        return p;
      });
    },
    async selectTile(tile) { await db.update(G, { tile }); },
    async showQuestion(g) {
      const q = await db.get(`questions/${g.tile}`);
      if (!q) throw new Error(`ยังไม่มีโจทย์ ${g.tile}`);
      const img = q.hasImg ? await db.get(`qimages/${g.tile}`) : null;
      const info = tileInfo(g.tile);
      await db.batch([
        { op: "set", path: "pub/current", data: {
          qid: g.tile, cat: info.cat, pts: g.suddenDeath ? 1 : info.pts, prompt: q.prompt || "", aPrompt: q.aPrompt || q.prompt || "",
          aType: q.aType === "mcq" ? "mcq" : "open", options: q.aType === "mcq" ? (q.options || []).slice(0, 4) : [], hasImg: !!img?.data, sd: !!g.suddenDeath,
        } },
        { op: "set", path: "pub/img", data: { qid: g.tile, data: img?.data || null } },
        { op: "set", path: "pub/reveal", data: { qid: null } },
        { op: "update", path: G, data: { phase: "question", qid: g.tile, ansOpen: true, qOpenedAt: db.TS, ansSecs: ANSWER_SECS, result: null, revealed: false, audWinner: null } },
      ]);
    },
    async addTime(g, s = 10) { await db.update(G, { ansSecs: (g.ansSecs || ANSWER_SECS) + s }); },
    async stopAnswers() { await db.update(G, { ansOpen: false }); },
    async judge(g, correct) {
      return db.tx(G, (cur) => {
        if (!cur || !cur.tile || !cur.buzzWinner || cur.result) return null;
        const team = cur.buzzWinner.team;
        const sd = !!cur.suddenDeath;
        const pts = sd ? 1 : tileInfo(cur.tile).pts;
        const isCh = cur.buzzWinner.via === "challenge";
        const delta = correct ? pts : (isCh && !sd ? -pts : 0);
        const p = {
          result: { team, correct, delta, challenge: isCh },
          ansOpen: false,
          [`scores.${team}`]: (cur.scores?.[team] || 0) + delta,
          [`used.${cur.tile}`]: { team, correct, delta, challenge: isCh, sd },
        };
        if (!sd && usedCount(cur) + 1 >= GAME_TILES) p.hideScores = true;
        return p;
      });
    },
    async undoResult() {
      return db.tx(G, (cur) => {
        if (!cur?.result || !cur.tile) return null;
        const { team, delta } = cur.result;
        return { result: null, [`scores.${team}`]: (cur.scores?.[team] || 0) - delta, [`used.${cur.tile}`]: db.DEL };
      });
    },
    async reveal(g) {
      const q = await db.get(`questions/${g.qid}`);
      let aw = g.audWinner || null;
      if (!aw && q?.aType === "mcq") aw = await A.autoWinner(g, q);
      const patch = { phase: "reveal", revealed: true, ansOpen: false };
      if (aw) { patch.audWinner = aw; patch[`audWinners.${g.qid}`] = aw; }
      await db.batch([
        { op: "set", path: "pub/reveal", data: { qid: g.qid, answerShort: q?.reveal || q?.answer || "", correctOption: q?.aType === "mcq" ? (q.correct || "") : "", accepted: q?.aType === "mcq" ? "" : acceptedList(q).slice(0, 3).join(" · ") } },
        { op: "update", path: G, data: patch },
      ]);
    },
    async autoWinner(g, q) {
      const rows = await db.list("answers", { where: [["qid", "==", g.qid]] });
      const taken = new Set(Object.entries(g.audWinners || {}).filter(([k]) => k !== g.qid).map(([, v]) => v.uid));
      const ok = rows.filter((r) => !taken.has(r.uid) && (q.aType === "mcq" ? r.choice === q.correct : isMatch(r.text, acceptedList(q))))
        .sort((a, b) => a.at - b.at);
      const w = ok[0];
      return w ? { uid: w.uid, name: w.name, inst: w.inst || "", ms: Math.max(0, w.at - (g.qOpenedAt || w.at)) } : null;
    },
    async setAudWinner(qid, w) {
      const p = { [`audWinners.${qid}`]: w || db.DEL };
      const g = await db.get(G);
      if (g?.qid === qid) p.audWinner = w || null;
      await db.update(G, p);
    },
    async toBoard() { await db.update(G, { phase: "board", tile: null, qid: null, buzzWinner: null, buzzOpen: false, ansOpen: false, result: null, revealed: false, audWinner: null }); },
    async setPhase(phase, extra = {}) { await db.update(G, { phase, ...extra }); },
    async adjust(team, d) { const g = await db.get(G); await db.update(G, { [`scores.${team}`]: (g.scores?.[team] || 0) + d }); },
  };
  return A;
}
