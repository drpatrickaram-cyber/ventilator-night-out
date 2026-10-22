import { initDB } from "./db.js";
import { h, mount, $, CATS, PTS, TEAM_KEYS, TEAM_COLORS, ALL_TILES, tileId, tileInfo, teamName, ranking, newGame, staffGate, toast, pageURL, qrSVG, downloadCSV, fmtDate } from "./core.js";

const app = $("#app");
let db;
let game = null, signup = {}, questions = {}, editing = null, counts = { players: 0, wall: 0 };
const run = (fn) => async (e) => { try { await fn(e); } catch (x) { console.error(x); toast(x.message || String(x), "bad"); } };
const btn = (label, fn, cls = "") => h("button", { class: `btn ${cls}`, type: "button", onclick: run(fn) }, label);

// ---------- game setup ----------
function gameCard() {
  const inputs = TEAM_KEYS.map((t) => h("input", { type: "text", id: `tn-${t}`, value: teamName(game, t) === t ? "" : teamName(game, t), placeholder: `ชื่อทีม ${t.slice(1)}`, maxlength: "40" }));
  const names = () => Object.fromEntries(TEAM_KEYS.map((t, i) => [t, { name: inputs[i].value.trim() || `ทีม ${i + 1}` }]));
  return h("section", { class: "card" }, h("h2", {}, "เกม"),
    h("div", { class: "grid3" }, TEAM_KEYS.map((t, i) => h("div", { class: "field" }, h("label", { for: `tn-${t}` }, h("span", { class: "dot", style: { background: TEAM_COLORS[t] } }), ` ทีม ${i + 1}`), inputs[i]))),
    h("div", { class: "row" },
      btn("บันทึกชื่อทีม", async () => { if (!game) throw new Error("กด ‘เริ่มเกมใหม่’ ก่อน"); await db.update("state/game", { teams: names() }); toast("บันทึกแล้ว", "good"); }, "primary"),
      btn("เริ่มเกมใหม่ (รีเซ็ตคะแนน)", async () => {
        if (game && !confirm("รีเซ็ตคะแนน กระดาน และผู้ชนะผู้ชมทั้งหมด? (โจทย์ไม่หาย)")) return;
        await db.batch([
          { op: "set", path: "state/game", data: newGame(names()) },
          { op: "set", path: "pub/current", data: { qid: null } },
          { op: "set", path: "pub/reveal", data: { qid: null } },
          { op: "set", path: "pub/img", data: { qid: null, data: null } },
        ]);
        toast("เริ่มเกมใหม่แล้ว", "good");
      }, "amber"),
      btn("ล้างคำตอบผู้ชม + การกด", async () => {
        if (!confirm("ลบคำตอบผู้ชมและประวัติการกดทั้งหมด?")) return;
        for (const c of ["answers", "buzz"]) {
          const rows = await db.list(c, {});
          for (let i = 0; i < rows.length; i += 400) await db.batch(rows.slice(i, i + 400).map((r) => ({ op: "delete", path: `${c}/${r.id}` })));
        }
        toast("ล้างแล้ว", "good");
      })),
    game ? h("div", { class: "muted", style: { fontSize: "13px" } }, `สถานะ: ${game.phase} · ผู้ชมลงชื่อ ${counts.players} คน`) : h("div", { class: "muted" }, "ยังไม่มีเกม — ตั้งชื่อทีมแล้วกด ‘เริ่มเกมใหม่’"));
}

// ---------- questions ----------
function questionsCard() {
  const have = ALL_TILES.filter((id) => questions[id]).length;
  return h("section", { class: "card" }, h("h2", {}, "โจทย์", h("span", { class: "pill" }, `${have}/12`)),
    h("div", { class: "gboard" }, CATS.map((c) => h("div", { class: "hd" }, c.short)),
      PTS.flatMap((p) => CATS.map((c) => {
        const id = tileId(c.id, p); const q = questions[id];
        return h("button", { class: `${editing === id ? "sel" : ""} ${q ? "" : "missing"}`, onclick: () => { editing = id; render(); } }, `${p}${q?.hasImg ? " 🖼" : ""}${q?.sample ? " ·ตัวอย่าง" : ""}`);
      }))),
    h("div", { class: "row" },
      btn("โหลดโจทย์ตัวอย่าง (ทดสอบ)", async () => {
        if (have && !confirm("แทนที่โจทย์ที่มีอยู่ด้วยโจทย์ตัวอย่าง?")) return;
        const data = await (await fetch("sample-questions.json", { cache: "no-store" })).json();
        await saveMany(data, true);
      }),
      btn("Export โจทย์ (JSON)", () => {
        const data = ALL_TILES.filter((id) => questions[id]).map((id) => { const { hasImg, ...q } = questions[id]; return { ...q, id }; });
        const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: "questions.json" });
        document.body.appendChild(a); a.click(); a.remove();
      }),
      h("label", { class: "btn", style: { margin: 0 } }, "Import JSON", h("input", { type: "file", accept: "application/json", class: "hidden", onchange: run(async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const data = JSON.parse(await f.text());
        if (!confirm(`นำเข้า ${data.length} ข้อ (แทนที่ข้อที่ id ตรงกัน)?`)) return;
        await saveMany(data, false);
      }) }))),
    editing ? editor(editing) : h("p", { class: "muted" }, "กดที่ช่องเพื่อแก้โจทย์ · ช่องที่มีกรอบแดงยังไม่มีโจทย์"));
}

async function saveMany(list, sample) {
  const ops = [];
  for (const q of list) {
    if (!ALL_TILES.includes(q.id)) continue;
    const { id, img, ...rest } = q;
    ops.push({ op: "set", path: `questions/${id}`, data: { ...clean(rest), hasImg: !!img || !!questions[id]?.hasImg, sample: !!sample } });
    if (img) ops.push({ op: "set", path: `qimages/${id}`, data: { data: img } });
  }
  await db.batch(ops);
  toast(`บันทึก ${ops.length} รายการ`, "good");
}
function clean(q) {
  return {
    prompt: q.prompt || "", answer: q.answer || "", criteria: q.criteria || "", aPrompt: q.aPrompt || "",
    aType: q.aType === "mcq" ? "mcq" : "open", options: (q.options || ["", "", "", ""]).slice(0, 4), correct: q.correct || "",
    accepted: q.accepted || "", reveal: q.reveal || "", pearl: q.pearl || "", ref: q.ref || "",
  };
}

function editor(id) {
  const q = questions[id] || clean({});
  const info = tileInfo(id);
  const f = (key, label, multi = false, hint = "") => {
    const el = multi ? h("textarea", { id: `q-${key}`, rows: "3" }, q[key] || "") : h("input", { type: "text", id: `q-${key}`, value: q[key] || "" });
    return h("div", { class: "field" }, h("label", { for: `q-${key}` }, label, hint ? h("span", { class: "muted", style: { fontWeight: 400 } }, ` · ${hint}`) : null), el);
  };
  const typeSel = h("select", { id: "q-aType" }, h("option", { value: "open", selected: q.aType !== "mcq" }, "อัตนัย (พิมพ์ตอบ)"), h("option", { value: "mcq", selected: q.aType === "mcq" }, "ปรนัย A–D"));
  const optInputs = [0, 1, 2, 3].map((i) => h("input", { type: "text", id: `q-o${i}`, value: q.options?.[i] || "", placeholder: `ตัวเลือก ${"ABCD"[i]}` }));
  const correctSel = h("select", { id: "q-correct" }, h("option", { value: "" }, "ข้อที่ถูก"), ["A", "B", "C", "D"].map((L) => h("option", { value: L, selected: q.correct === L }, L)));
  let newImg = undefined; // undefined = unchanged, null = remove, string = new
  const preview = h("div", { style: { maxWidth: "320px" } });
  if (q.hasImg) db.get(`qimages/${id}`).then((d) => { if (d?.data) preview.replaceChildren(h("img", { src: d.data, alt: "ภาพประกอบ", style: { width: "100%", borderRadius: "8px" } })); });
  const file = h("input", { type: "file", accept: "image/*", id: "q-img", onchange: run(async (e) => {
    const fl = e.target.files[0]; if (!fl) return;
    newImg = await shrink(fl);
    preview.replaceChildren(h("img", { src: newImg, alt: "ภาพประกอบ", style: { width: "100%", borderRadius: "8px" } }), h("div", { class: "muted", style: { fontSize: "12px" } }, `${Math.round(newImg.length / 1024)} KB`));
  }) });
  const save = run(async () => {
    const val = (k) => $(`#q-${k}`).value.trim();
    const data = clean({
      prompt: val("prompt"), answer: val("answer"), criteria: val("criteria"), aPrompt: val("aPrompt"), aType: typeSel.value,
      options: optInputs.map((o) => o.value.trim()), correct: correctSel.value, accepted: val("accepted"), reveal: val("reveal"), pearl: val("pearl"), ref: val("ref"),
    });
    if (!data.prompt) throw new Error("ต้องมีโจทย์");
    if (data.aType === "mcq" && (!data.correct || data.options.some((o) => !o))) throw new Error("ปรนัยต้องมีตัวเลือกครบ 4 ข้อ และเลือกข้อที่ถูก");
    if (data.aType === "open" && !data.accepted) throw new Error("อัตนัยต้องมีคำตอบที่ยอมรับอย่างน้อย 1 คำ");
    const hasImg = newImg === undefined ? !!q.hasImg : !!newImg;
    const ops = [{ op: "set", path: `questions/${id}`, data: { ...data, hasImg, sample: false } }];
    if (newImg) ops.push({ op: "set", path: `qimages/${id}`, data: { data: newImg } });
    if (newImg === null) ops.push({ op: "delete", path: `qimages/${id}` });
    await db.batch(ops);
    toast(`บันทึก ${id} แล้ว`, "good");
  });
  return h("form", { class: "card", style: { background: "#FAFCFE" }, onsubmit: (e) => { e.preventDefault(); save(); } },
    h("h2", {}, `แก้โจทย์ ${info.catObj.full} · ${info.pts} คะแนน`, h("span", { class: "pill" }, id)),
    f("prompt", "โจทย์ (ขึ้นจอ)", true, "≤ 2 บรรทัด"),
    h("div", { class: "field" }, h("label", { for: "q-img" }, "ภาพประกอบ"), file, preview, q.hasImg || newImg ? h("button", { type: "button", class: "btn small", onclick: () => { newImg = null; preview.replaceChildren(h("div", { class: "muted" }, "จะลบภาพเมื่อกดบันทึก")); } }, "ลบภาพ") : null),
    f("answer", "คำตอบที่ถูก (สำหรับ GM)", true), f("criteria", "เกณฑ์ตัดสินว่าถูก", true),
    f("aPrompt", "คำถามสำหรับผู้ชม", false, "เว้นว่าง = ใช้โจทย์หลัก"),
    h("div", { class: "field" }, h("label", { for: "q-aType" }, "ประเภทคำตอบผู้ชม"), typeSel),
    h("div", { class: "grid3", style: { gridTemplateColumns: "repeat(2, minmax(0,1fr))" } }, optInputs), h("div", { class: "field" }, h("label", { for: "q-correct" }, "ข้อที่ถูก (ปรนัย)"), correctSel),
    f("accepted", "คำตอบที่ยอมรับ (อัตนัย)", false, "คั่นด้วยจุลภาค"),
    f("reveal", "เฉลยสั้น (ขึ้นจอ)", true), f("pearl", "Pearl ให้ expert"), f("ref", "เอกสารอ้างอิง"),
    h("div", { class: "row" }, h("button", { type: "submit", class: "btn primary" }, "บันทึกโจทย์"), h("button", { type: "button", class: "btn", onclick: () => { editing = null; render(); } }, "ปิด")));
}

function shrink(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85, out = c.toDataURL("image/jpeg", q);
      while (out.length > 700000 && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
      URL.revokeObjectURL(img.src); res(out);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- signup + exports ----------
function signupCard() {
  return h("section", { class: "card" }, h("h2", {}, "สมัครสมาชิก", h("span", { class: "pill" }, `${counts.wall} คน`)),
    h("div", { class: "row" },
      h("span", { class: "pill", style: { background: signup.open ? "#E6F7EE" : "" } }, signup.open ? "ฟอร์มเปิดอยู่" : "ฟอร์มปิดอยู่"),
      btn(signup.open ? "ปิดฟอร์ม" : "เปิดฟอร์ม", () => db.set("state/signup", { open: !signup.open }, true)),
      btn(signup.launched ? "ยกเลิก Launch (ไม่เด้งในมือถือ)" : "Launch (เด้งในมือถือผู้ชม)", () => db.set("state/signup", { launched: !signup.launched }, true))),
    h("div", { class: "row" },
      btn("Export สมาชิก (CSV)", async () => {
        const rows = (await db.list("members", {})).sort((a, b) => a.at - b.at);
        downloadCSV("founding-members.csv", [["ลำดับ", "ชื่อ-สกุล", "สถาบัน", "ตำแหน่ง", "อีเมล", "เวลาสมัคร"], ...rows.map((r, i) => [i + 1, r.name, r.inst, r.pos, r.email, fmtDate(r.at)])]);
      }, "primary"),
      btn("Export ผู้ชมที่ลงชื่อ", async () => {
        const rows = (await db.list("players", {})).sort((a, b) => a.at - b.at);
        downloadCSV("audience.csv", [["ชื่อ-สกุล", "สถาบัน", "เวลา"], ...rows.map((r) => [r.name, r.inst, fmtDate(r.at)])]);
      }),
      btn("Export ผลรางวัล", async () => {
        const g = await db.get("state/game");
        const aw = Object.entries(g?.audWinners || {}).filter(([, w]) => w).sort(([a], [b]) => a.localeCompare(b));
        downloadCSV("results.csv", [["ประเภท", "ข้อ/อันดับ", "ชื่อ", "สถาบัน/คะแนน"],
          ...ranking(g).map((r, i) => ["ทีม", i + 1, r.name, r.score]), ...aw.map(([q, w]) => ["ผู้ชม", q, w.name, w.inst])]);
      }),
      btn("Export คำตอบผู้ชมทั้งหมด", async () => {
        const rows = (await db.list("answers", {})).sort((a, b) => (a.qid + a.at).localeCompare(b.qid + b.at));
        downloadCSV("answers.csv", [["ข้อ", "ชื่อ", "สถาบัน", "คำตอบ", "เวลา"], ...rows.map((r) => [r.qid, r.name, r.inst, r.choice || r.text, fmtDate(r.at)])]);
      })));
}

function linksCard() {
  const qrBox = (url, label) => { const d = h("div", { style: { width: "130px" } }); d.innerHTML = qrSVG(url); return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", fontSize: "13px", textAlign: "center" } }, h("a", { href: url, target: "_blank" }, d), label); };
  return h("section", { class: "card" }, h("h2", {}, "ลิงก์และ QR"),
    h("div", { class: "row" },
      h("a", { class: "btn", href: pageURL("screen.html"), target: "_blank" }, "จอหลัก"),
      h("a", { class: "btn", href: pageURL("gm.html"), target: "_blank" }, "Game Master"),
      h("a", { class: "btn", href: pageURL("judge.html"), target: "_blank" }, "กรรมการผู้ชม")),
    h("div", { class: "muted", style: { fontSize: "13px" } }, "ปุ่มกดทีม: สแกนด้วยมือถือ/tablet ของแต่ละทีม (ต้องใส่ PIN ครั้งแรก)"),
    h("div", { class: "row", style: { gap: "16px" } }, TEAM_KEYS.map((t, i) => qrBox(pageURL("buzzer.html", { team: t }), `ปุ่ม ${teamName(game, t)}`)),
      qrBox(pageURL("index.html"), "ผู้ชมร่วมเล่น"), qrBox(pageURL("index.html", { signup: "1" }), "สมัครสมาชิก")));
}

function render() {
  const focusId = document.activeElement?.id;
  if (editing && document.activeElement?.matches?.("input, textarea, select") && document.activeElement.closest("form")) return; // don't wipe the editor while typing
  mount(app, h("header", { class: "p-top" }, h("h1", {}, "Admin"), h("div", { class: "sp" }), h("span", { class: "muted", style: { color: "#A9B8C8", fontSize: "13px" } }, db?.backend === "dev" ? "DEV MODE" : "")),
    h("main", { class: "p-main" }, h("div", { class: "p-col" }, gameCard(), questionsCard()), h("div", { class: "p-col" }, signupCard(), linksCard())));
  if (focusId) document.getElementById(focusId)?.focus();
}

(async () => {
  db = await initDB();
  await staffGate(db, "Admin");
  db.onDoc("state/game", (g) => { game = g; render(); });
  db.onDoc("state/signup", (d) => { signup = d || {}; render(); });
  db.onColl("questions", {}, (rows) => { questions = Object.fromEntries(rows.map((r) => [r.id, r])); render(); });
  db.onColl("players", {}, (rows) => { counts.players = rows.length; });
  db.onColl("wall", {}, (rows) => { counts.wall = rows.length; render(); });
})();
