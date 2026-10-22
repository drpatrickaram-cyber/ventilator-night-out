# Ventilator Night Out · The Ventilator Games

Web app สำหรับงานเปิดตัว TSCCM Mechanical Ventilator Assembly (13 พ.ย. 2569)
เกมกระดาน 12 ช่องสำหรับ 3 ทีม fellow + ผู้ชมร่วมตอบผ่านมือถือ + สมัคร Founding Member + Live Wall

## หน้าต่าง ๆ

| หน้า | ใช้โดย | ต้องใช้ PIN |
|---|---|---|
| `index.html` | ผู้ชม (ร่วมเล่น / สมัครสมาชิก `?signup=1`) | – |
| `screen.html` | จอหลัก (กด 1/2/3 บนคีย์บอร์ด = ปุ่ม USB สำรอง) | ✓ |
| `gm.html` | Game Master | ✓ |
| `judge.html` | กรรมการตัดสินคำตอบผู้ชม | ✓ |
| `buzzer.html?team=t1` (t2, t3) | ปุ่มกดของแต่ละทีม | ✓ |
| `admin.html` | ตั้งชื่อทีม ใส่โจทย์ เปิดฟอร์ม export | ✓ |

## ตั้งค่าครั้งแรก

1. Firebase: เปิด Anonymous Authentication และสร้าง Firestore (asia-southeast1)
2. Firestore → Rules → วางเนื้อหาไฟล์ `firestore.rules` → Publish
3. Firestore → Data → สร้าง collection `config` → document id `secret` → field `pin` (ชนิด **string**) = PIN 6 หลักของทีมงาน
4. ใส่ค่า firebaseConfig ใน `js/config.js`
5. GitHub → Settings → Pages → Deploy from branch `main` / root

โจทย์จริงเก็บใน Firestore เท่านั้น (ใส่ผ่านหน้า Admin) — ห้าม commit โจทย์จริงลง repo นี้เพราะเป็น public

## ทดสอบในเครื่อง

```
npm i ws
node tools/devserver.js . 8787      # เปิด http://localhost:8787/admin.html?dev=1  (PIN 123456)
node tools/e2e.mjs                  # เล่นเกมเต็มรอบอัตโนมัติด้วย Playwright
```
