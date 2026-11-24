// 업체(파트너) 관리 API: 추가/요율/충전·차감/잔액/삭제 + 회원 차단
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("업체 관리: 충전/차감으로 잔액 계산 + 회원 차단", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partner-test-"));
  const port = 3900 + Math.floor(Math.random() * 300);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", CAFE_COMMENT_AUTO: "off", APP_PASSWORD: "adminpass123" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { let cookie = ""; return { call: async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const data = await r.json().catch(() => null); return { status: r.status, data }; } }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const admin = client();
    await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" });

    assert.strictEqual((await admin.call("POST", "/api/partners", { media: "스레드" })).status, 400); // 이름 필수
    const add = await admin.call("POST", "/api/partners", { name: "J컴퍼니", media: "스레드", memo: "스레드 발행 1건 1만원", rates: [{ label: "스레드 발행", price: 10000 }, { label: "댓글 추가", price: 5000 }] });
    assert.strictEqual(add.status, 201);
    const id = add.data.partner.id;
    assert.strictEqual(add.data.partner.rates.length, 2);
    assert.strictEqual(add.data.partner.balance, 0);

    // 충전 50만원(세금계산서 발행) → 잔액 500000, 부가세 10% 기록
    assert.strictEqual((await admin.call("POST", `/api/partners/${id}/entries`, { type: "topup", amount: 500000, label: "선금 충전", vat: true })).data.balance, 500000);
    const topup = (await admin.call("GET", "/api/partners")).data.partners[0].entries.find((e) => e.type === "topup");
    assert.strictEqual(topup.vat, true);
    assert.strictEqual(topup.vatAmount, 50000); // 부가세는 잔액에 반영 안 됨(기록만)
    // 차감: 스레드 발행 3건 3만원
    assert.strictEqual((await admin.call("POST", `/api/partners/${id}/entries`, { type: "charge", amount: 30000, label: "스레드 발행 3건" })).data.balance, 470000);
    // 금액 0 이하 거부
    assert.strictEqual((await admin.call("POST", `/api/partners/${id}/entries`, { type: "charge", amount: 0 })).status, 400);
    // 잔액보다 큰 차감도 허용(마이너스)
    assert.strictEqual((await admin.call("POST", `/api/partners/${id}/entries`, { type: "charge", amount: 600000, label: "대량 발행" })).data.balance, -130000);

    const list = await admin.call("GET", "/api/partners");
    const p = list.data.partners.find((x) => x.id === id);
    assert.strictEqual(p.balance, -130000);
    assert.strictEqual(p.entries.length, 3);
    assert.strictEqual(p.entries[0].date.length, 10); // 날짜 자동 채움

    // 요율/메모 수정
    assert.strictEqual((await admin.call("PATCH", `/api/partners/${id}`, { rates: [{ label: "스레드 발행", price: 12000 }] })).data.partner.rates[0].price, 12000);
    assert.strictEqual((await admin.call("PATCH", `/api/partners/${id}`, { name: "" })).status, 400); // 빈 이름 거부

    // 내역 삭제 → 잔액 복원
    const eid = p.entries.find((e) => e.amount === 600000).id;
    assert.strictEqual((await admin.call("DELETE", `/api/partners/${id}/entries/${eid}`)).data.balance, 470000);

    // 업체 삭제
    assert.strictEqual((await admin.call("DELETE", `/api/partners/${id}`)).data.removed, 1);
    assert.strictEqual((await admin.call("GET", "/api/partners")).data.partners.length, 0);

    // 회원(viewer)은 전부 차단
    await admin.call("POST", "/api/users", { username: "viewer9", password: "viewerpass1", tools: ["rank"] });
    const v = client();
    await v.call("POST", "/api/login", { username: "viewer9", password: "viewerpass1" });
    for (const [m, u, b] of [["GET", "/api/partners"], ["POST", "/api/partners", { name: "x" }], ["PATCH", "/api/partners/any", { name: "y" }], ["DELETE", "/api/partners/any"], ["POST", "/api/partners/any/entries", { type: "topup", amount: 100 }]]) {
      assert.strictEqual((await v.call(m, u, b)).status, 403, `${m} ${u}`);
    }
  } finally { child.kill(); }
});
