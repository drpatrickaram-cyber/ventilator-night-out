// End-to-end run of a full game against the local dev backend.
import { createRequire } from "module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:8787";
const SHOTS = process.env.SHOTS || "/tmp/shots";
const fs = await import("fs");
fs.mkdirSync(SHOTS, { recursive: true });
await fetch(`${BASE}/__reset`);

const browser = await chromium.launch();
const errors = [];
const pages = {};
async function open(name, path, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.vp || { width: 1366, height: 860 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console: ${m.text()}`); });
  p.on("dialog", (d) => d.accept());
  await p.goto(`${BASE}/${path}${path.includes("?") ? "&" : "?"}dev=1`);
  pages[name] = p;
  return p;
}
async function login(p) { await p.locator("#pin").fill("123456"); await p.getByRole("button", { name: "เข้าสู่ระบบ" }).click(); await p.waitForTimeout(300); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (p, name) => { await p.getByRole("button", { name, exact: false }).first().click(); await wait(250); };
const shot = async (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` });
function check(cond, msg) { if (!cond) { console.log("FAIL:", msg); process.exitCode = 1; } else console.log("ok  ", msg); }

// --- admin setup
const admin = await open("admin", "admin.html");
await login(admin);
await admin.locator("#tn-t1").fill("PMK Breathers");
await admin.locator("#tn-t2").fill("Chula Plateau");
await admin.locator("#tn-t3").fill("North PEEPs");
await click(admin, "เริ่มเกมใหม่");
await click(admin, "โหลดโจทย์ตัวอย่าง");
await wait(500);
check((await admin.locator(".gboard button.missing").count()) === 0, "12 sample questions loaded");
await shot(admin, "01-admin");

// --- screen + gm + judge + buzzers
const screen = await open("screen", "screen.html", { vp: { width: 1600, height: 900 } });
await login(screen);
await screen.locator("#start").click().catch(() => {});
const gm = await open("gm", "gm.html", { vp: { width: 1440, height: 1000 } });
await login(gm);
const judge = await open("judge", "judge.html");
await login(judge);
const bz = {};
for (const t of ["t1", "t2", "t3"]) { bz[t] = await open(`bz-${t}`, `buzzer.html?team=${t}`, { vp: { width: 390, height: 844 } }); await login(bz[t]); }

// --- audience
const aud = {};
const people = [["นพ.เอ ทดสอบ", "รพ.พระมงกุฎเกล้า"], ["พญ.บี ทดสอบ", "รพ.จุฬาลงกรณ์"], ["นพ.ซี ทดสอบ", "รพ.นครพิงค์"]];
for (let i = 0; i < 3; i++) {
  const p = await open(`aud${i + 1}`, "index.html", { vp: { width: 390, height: 844 } });
  await p.locator("#nm").fill(people[i][0]); await p.locator("#inst").fill(people[i][1]);
  await click(p, "เข้าร่วม");
  aud[i + 1] = p;
}
await wait(500);
await shot(screen, "02-lobby");
check((await screen.locator(".big-count").textContent()) === "3", "lobby shows 3 audience");
await shot(aud[1], "03-aud-wait");

// --- Q1: phone buzz race → WF20 (mcq)
await click(gm, "กระดาน");
await click(gm, "เปิดให้กด");
await shot(bz.t2, "04-buzzer-go");
await bz.t2.locator(".bz").dispatchEvent("pointerdown");
await wait(60);
await bz.t1.locator(".bz").dispatchEvent("pointerdown");
await wait(900);
check((await gm.locator(".big-status").textContent()).includes("Chula Plateau"), "t2 wins the buzz race");
await shot(bz.t2, "05-buzzer-won"); await shot(bz.t1, "05b-buzzer-lost");
await gm.locator('.gboard button[title="WF20"]').click(); await wait(250);
await shot(screen, "06-board-selected");
await click(gm, "ขึ้นโจทย์บนจอ");
await wait(400);
await aud[1].locator(".opt-btn").nth(0).click(); await wait(150);
await aud[2].locator(".opt-btn").nth(1).click(); await wait(150);
await aud[3].locator(".opt-btn").nth(0).click(); await wait(300);
await shot(screen, "07-question-mcq"); await shot(aud[1], "08-aud-answered");
await click(gm, "✓ ตอบถูก"); await wait(300);
await shot(screen, "09-verdict");
await click(gm, "เฉลย"); await wait(500);
await shot(screen, "10-reveal-mcq"); await shot(aud[1], "11-aud-win");
check((await screen.locator(".aud .who").textContent()) === people[0][0], "fastest correct audience (aud1) wins Q1");
check((await gm.locator(".teamcard .sc").nth(1).textContent()) === "20", "t2 scored 20");
await click(gm, "กลับกระดาน");

// --- Q2: challenge by t3 → WF30 (open), wrong → -30, judge picks aud2
await gm.getByRole("button", { name: "North PEEPs · Challenge" }).click(); await wait(250);
await gm.locator('.gboard button[title="WF30"]').click(); await wait(200);
await click(gm, "ขึ้นโจทย์บนจอ"); await wait(400);
await aud[1].locator("#ans").fill("double trigger"); await aud[1].getByRole("button", { name: "ส่งคำตอบ" }).click(); await wait(200);
await aud[2].locator("#ans").fill("Breath stacking"); await aud[2].getByRole("button", { name: "ส่งคำตอบ" }).click(); await wait(200);
await aud[3].locator("#ans").fill("auto-PEEP"); await aud[3].getByRole("button", { name: "ส่งคำตอบ" }).click(); await wait(400);
await shot(judge, "12-judge");
check((await judge.locator("tr.taken").count()) === 1, "judge greys out previous winner (aud1)");
check((await judge.locator("tr.match").count()) === 1, "judge highlights aud2 match");
await judge.locator("tr.match button").click(); await wait(300);
await click(gm, "✗ ตอบผิด"); await wait(300);
check((await gm.locator(".teamcard .sc").nth(2).textContent()) === "-30", "challenge wrong → -30");
await click(gm, "เฉลย"); await wait(400);
await shot(screen, "13-reveal-open");
check((await screen.locator(".aud .who").textContent()) === people[1][0], "judge-picked aud2 shown on screen");
await click(gm, "กลับกระดาน");

// --- Q3..Q9 via bell fallback and keyboard
const rest = ["WF10", "SD10", "SD20", "SD30", "MM10", "MM20", "MM30"];
for (let i = 0; i < rest.length; i++) {
  await click(gm, "เปิดให้กด");
  if (i === 0) { await screen.keyboard.press("1"); await wait(300); }
  else await gm.getByRole("button", { name: `กริ่ง ${["PMK Breathers", "Chula Plateau", "North PEEPs"][i % 3]}` }).click();
  await wait(250);
  await gm.locator(`.gboard button[title="${rest[i]}"]`).click(); await wait(150);
  await click(gm, "ขึ้นโจทย์บนจอ"); await wait(250);
  await click(gm, i % 2 ? "✗ ตอบผิด" : "✓ ตอบถูก"); await wait(200);
  if (i === rest.length - 1) await shot(screen, "14-last-verdict-hidden");
  await click(gm, "เฉลย"); await wait(250);
  await click(gm, "กลับกระดาน"); await wait(150);
}
await shot(screen, "15-board-hidden");
check((await screen.locator(".team .sc").first().textContent()) === "?", "scores hidden after 9 tiles");
check((await gm.locator(".gboard button:not(.used):not([disabled])").count()) === 0, "board locked after 9");
await click(gm, "จบเกม"); await wait(300);
await shot(screen, "16-end");

// --- signup
await click(gm, "Launch สมัครสมาชิก"); await wait(600);
await shot(aud[1], "17-aud-signup-sheet");
for (const [i, email] of [[1, "a@test.com"], [3, "c@test.com"], [2, "A@Test.com"]]) {
  const p = aud[i];
  await p.locator("#s-pos").selectOption("Fellow");
  await p.locator("#s-email").fill(email);
  await p.getByRole("button", { name: "สมัครเลย" }).click();
  await wait(700);
}
await shot(aud[1], "18-aud-member"); await shot(aud[2], "18b-aud-dup");
check((await aud[1].locator(".member .no").textContent()) === "#001", "first member number #001");
check((await aud[3].locator(".member .no").textContent()) === "#002", "second member number #002");
check((await screen.locator("#wallcount").textContent()) === "002", "wall counts 2 (duplicate email ignored)");
await shot(screen, "19-wall");
const so = await open("signup-only", "index.html?signup=1", { vp: { width: 390, height: 844 } });
await wait(500); await shot(so, "20-signup-only");

// --- awards
for (let s = 0; s <= 4; s++) {
  await gm.getByRole("button", { name: ["หัวข้อ", "ผู้ชม 9 คน", "อันดับ 3", "อันดับ 2", "ชนะเลิศ"][s], exact: true }).click(); await wait(400);
  await shot(screen, `21-awards-${s}`);
}
await shot(gm, "22-gm");

// --- exports
const [dl] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("button", { name: "Export สมาชิก (CSV)" }).click()]);
const csv = fs.readFileSync(await dl.path(), "utf8");
check(csv.includes("a@test.com") && csv.split("\r\n").length === 3, "members CSV has 2 rows");
await shot(admin, "23-admin-end");

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
