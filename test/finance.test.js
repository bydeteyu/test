// 경영관리(입출금) + 마스터 권한: 마스터만 접근, admin 은 차단, admin 이 마스터를 건드릴 수 없음
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("마스터 전용 입출금 + admin 은 마스터 수정/삭제 불가", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-test-"));
  const port = 4300 + Math.floor(Math.random() * 300);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", CAFE_COMMENT_AUTO: "off", APP_PASSWORD: "adminpass123", MASTER_PASSWORD: "masterpass123" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { let cookie = ""; return { call: async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const data = await r.json().catch(() => null); return { status: r.status, data, location: r.headers.get("location") }; } }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const admin = client(), master = client(), anon = client();

    assert.strictEqual((await anon.call("GET", "/api/finance")).status, 401);
    assert.strictEqual((await admin.call("POST", "/api/login", { username: "admin", password: "masterpass123" })).status, 401);
    assert.strictEqual((await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" })).status, 200);
    assert.strictEqual((await master.call("POST", "/api/login", { username: "master", password: "masterpass123" })).status, 200);

    // admin: 입출금 API/페이지 차단, 기존 권한은 유지
    assert.strictEqual((await admin.call("GET", "/api/finance")).status, 403);
    assert.strictEqual((await admin.call("POST", "/api/finance", { type: "in", amount: 1000 })).status, 403);
    assert.strictEqual((await admin.call("GET", "/api/finance/csv")).status, 403);
    assert.strictEqual((await admin.call("GET", "/finance.html")).location, "/home.html");
    assert.strictEqual((await admin.call("GET", "/api/users")).status, 200);
    assert.strictEqual((await admin.call("GET", "/api/me")).data.master, false);

    // master: admin 권한 + 입출금
    const me = (await master.call("GET", "/api/me")).data;
    assert.strictEqual(me.role, "admin");
    assert.strictEqual(me.master, true);
    assert.strictEqual((await master.call("GET", "/api/users")).status, 200);
    assert.strictEqual((await master.call("GET", "/api/partners")).status, 200);
    assert.strictEqual((await master.call("POST", "/api/finance", { type: "in", amount: 0 })).status, 400);
    assert.strictEqual((await master.call("POST", "/api/finance", { type: "x", amount: 100 })).status, 400);
    const a = await master.call("POST", "/api/finance", { type: "in", amount: 500000, date: "2026-11-02", category: "매출", counterparty: "J컴퍼니" });
    assert.strictEqual(a.status, 201);
    await master.call("POST", "/api/finance", { type: "out", amount: 120000, date: "2026-11-05", category: "광고비" });
    await master.call("POST", "/api/finance", { type: "out", amount: 30000, date: "2026-10-30" });
    const nov = (await master.call("GET", "/api/finance?month=2026-11")).data;
    assert.strictEqual(nov.entries.length, 2);
    assert.deepStrictEqual(nov.summary, { income: 500000, expense: 120000, net: 380000 });
    assert.strictEqual(nov.total.net, 350000);
    assert.strictEqual((await master.call("PATCH", `/api/finance/${a.data.entry.id}`, { amount: 600000 })).data.entry.amount, 600000);
    assert.strictEqual((await master.call("DELETE", `/api/finance/${a.data.entry.id}`)).data.removed, 1);

    // admin 은 마스터 계정을 만들거나 바꾸거나 지울 수 없다
    assert.strictEqual((await admin.call("POST", "/api/users", { username: "master", password: "whatever123" })).status, 409);
    const list = (await admin.call("GET", "/api/users")).data;
    assert.strictEqual(list.master, "master");
    assert.ok(!list.users.some((u) => u.username === "master"));
    assert.strictEqual((await admin.call("PATCH", "/api/users/master", { password: "hacked1234" })).status, 404);
    assert.strictEqual((await admin.call("DELETE", "/api/users/master")).data.ok, true); // 존재하지 않는 id → 영향 없음
    assert.strictEqual((await client().call("POST", "/api/login", { username: "master", password: "masterpass123" })).status, 200);

    // 일반 회원도 차단
    await admin.call("POST", "/api/users", { username: "viewer1", password: "viewerpass1" });
    const v = client(); await v.call("POST", "/api/login", { username: "viewer1", password: "viewerpass1" });
    assert.strictEqual((await v.call("GET", "/api/finance")).status, 403);
  } finally { child.kill(); }
});
