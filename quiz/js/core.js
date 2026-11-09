// Shared helpers for the audience quiz (player · screen · host).
import qrcode from "./vendor/qrcode.mjs";

// ---------- Firestore paths ----------
export const P = {
  state: "q_state/live",       // phase, current question, timing, counters (public)
  pub: "q_pub/current",        // the open question as players see it (public)
  config: "q_pub/config",      // title, default seconds, prize rule (public)
  board: "q_board/live",       // leaderboard + ranks map (public)
  counts: "q_pub/counts",      // live counters for the big screen only (phones do not listen)
  bank: "q_bank",              // question bank (staff)
  bankImg: "q_bankimg",        // question images, one doc per question (staff)
  players: "q_players",        // one doc per player uid
  answers: "q_answers",        // `${qid}_${uid}`
  results: "q_results",        // per-question marks + scores (staff)
};

export const DEFAULT_SECS = 30;
export const MAX_ANSWER = 120;

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

window.addEventListener("vno-conn", (e) => {
  let b = document.getElementById("conn-badge");
  if (!b) { b = h("div", { id: "conn-badge", role: "status" }, "กำลังเชื่อมต่อใหม่…"); document.body.appendChild(b); }
  clearTimeout(b._t);
  if (e.detail.online) b.hidden = true;
  else b._t = setTimeout(() => { b.hidden = false; }, 3000);
});

export function toast(msg, kind = "") {
  let box = $("#toasts");
  if (!box) { box = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.appendChild(box); }
  const t = h("div", { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- URLs / QR ----------
export function pageURL(page, params = {}) {
  const u = new URL(page, location.href);
  u.search = "";
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
export const prettyURL = (u) => u.replace(/\?.*$/, "").replace(/^https?:\/\//, "").replace(/\/index\.html$/, "/").replace(/\/$/, "");

// ---------- answer matching ----------
export function norm(s) {
  return String(s || "").normalize("NFC").toLowerCase()
    .replace(/[​-‍﻿]/g, "")
    .replace(/[\s\-_.·,/()'"’“”:;!?[\]{}]+/g, "");
}
export function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** Auto verdict for an open answer: exact after normalising, or a small typo on longer answers. */
export function autoJudge(text, accepted) {
  const t = norm(text);
  if (!t) return false;
  return (accepted || []).some((a) => {
    const n = norm(a);
    if (!n) return false;
    if (t === n) return true;
    const tol = n.length >= 12 ? 2 : n.length >= 6 ? 1 : 0;
    return tol > 0 && Math.abs(t.length - n.length) <= tol && lev(t, n) <= tol;
  });
}
export const splitAccepted = (s) => String(s || "").split(/[\n,;|]+/).map((x) => x.trim()).filter(Boolean);

// ---------- scoring (Kahoot-style: 1000 at 0 s → 500 at the buzzer) ----------
export function points(ms, secs) {
  const frac = Math.min(Math.max(ms, 0) / (secs * 1000), 1);
  return Math.round(1000 * (1 - frac / 2));
}

// ---------- time ----------
export function remainingMs(state, now) {
  if (!state?.openedAt) return 0;
  return Math.max(0, state.openedAt + (state.secs || DEFAULT_SECS) * 1000 - now);
}
export const fmtSec = (ms) => (ms / 1000).toFixed(2);
export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("th-TH", { hour12: false }) : "");
export const nf = (n) => Number(n || 0).toLocaleString("th-TH");

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
  open() { [523, 784].forEach((f, i) => this.tone(f, 0.22, "triangle", 0.2, i * 0.1)); }
  tick() { this.tone(1000, 0.08, "sine", 0.15); }
  stop() { this.tone(220, 0.5, "square", 0.16); this.tone(165, 0.5, "square", 0.1, 0.04); }
  reveal() { [392, 523, 659].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.2, i * 0.11)); }
  fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.3, "triangle", 0.24, i * 0.14)); }
  ding() { this.tone(1320, 0.2, "sine", 0.14); }
}

export async function keepAwake() {
  try {
    if (!("wakeLock" in navigator)) return;
    await navigator.wakeLock.request("screen");
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") navigator.wakeLock.request("screen").catch(() => {}); });
  } catch (e) { /* not supported */ }
}

// ---------- staff gate (shared 6-digit PIN in config/secret) ----------
export async function staffGate(db, title) {
  const mine = await db.get(`staff/${db.uid}`).catch(() => null);
  if (mine) return true;
  return new Promise((resolve) => {
    const input = h("input", { id: "pin", type: "password", inputmode: "numeric", maxlength: "6", autocomplete: "off", placeholder: "••••••", class: "pin-input" });
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
        h("p", { class: "gate-kicker" }, "Ventilator Night Out · ทีมงาน"),
        h("h1", {}, title),
        h("label", { for: "pin" }, "PIN ทีมงาน"),
        input, msg,
        h("button", { type: "submit", class: "btn btn-primary btn-lg" }, "เข้าสู่ระบบ")));
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------- CSV ----------
export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadBlob(filename, new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
}
export function downloadBlob(filename, blob) {
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- images: shrink to a Firestore-friendly JPEG data URL ----------
export async function compressImage(file, maxSide = 1400, maxBytes = 380_000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let side = maxSide;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), hgt = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas"); c.width = w; c.height = hgt;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hgt);
      ctx.drawImage(img, 0, 0, w, hgt);
      for (const q of [0.85, 0.75, 0.65]) {
        const data = c.toDataURL("image/jpeg", q);
        if (data.length * 0.75 <= maxBytes) return { data, w, h: hgt };
      }
      side = Math.round(side * 0.75);
    }
    throw new Error("ภาพใหญ่เกินไป");
  } finally { URL.revokeObjectURL(url); }
}

// ---------- text import ----------
// Blocks separated by a blank line. First lines = question text. Tagged lines:
//   ตอบ: / คำตอบ: / answer: / a:      accepted answers (comma, ; or | separated)
//   เฉลย: / show:                       answer text to display at reveal (optional)
//   เวลา: / time: / secs:               seconds (optional)
//   ป้าย: / หมวด: / label:              label such as "Waveform 20" (optional)
// One-line form also works:  question text | answer1, answer2
export function parseTextImport(raw) {
  const out = [];
  const blocks = String(raw || "").replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const q = { text: "", accepted: [], display: "", secs: null, label: "" };
    const textLines = [];
    for (let line of lines) {
      line = line.replace(/^\d+\s*[.)]\s*/, "");
      const m = line.match(/^(ตอบ|คำตอบ|answers?|a|เฉลย|show|เวลา|time|secs?|ป้าย|หมวด|label)\s*[:：]\s*(.*)$/i);
      if (m) {
        const key = m[1].toLowerCase(), val = m[2].trim();
        if (["ตอบ", "คำตอบ", "answer", "answers", "a"].includes(key)) q.accepted.push(...splitAccepted(val));
        else if (["เฉลย", "show"].includes(key)) q.display = val;
        else if (["เวลา", "time", "sec", "secs"].includes(key)) q.secs = parseInt(val, 10) || null;
        else q.label = val;
      } else if (!q.accepted.length && line.includes("|") && lines.length === 1) {
        const [t, a] = line.split("|");
        textLines.push(t.trim()); q.accepted.push(...splitAccepted(a));
      } else textLines.push(line);
    }
    q.text = textLines.join("\n");
    if (q.text || q.accepted.length) out.push(q);
  }
  return out;
}

export const uidShort = (u) => String(u || "").slice(0, 6);
