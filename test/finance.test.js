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
  const client = () => { let cookie = ""; return { cookie: () => cookie, call: async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const data = await r.json().catch(() => null); return { status: r.status, data, location: r.headers.get("location") }; } }; };
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
    // 삭제는 숨김일 뿐: 목록·합계에서는 빠지지만 보관되고 복구된다
    assert.strictEqual((await master.call("GET", "/api/finance?month=2026-11")).data.entries.length, 1);
    const del = (await master.call("GET", "/api/finance/deleted")).data.entries;
    assert.strictEqual(del.length, 1);
    assert.strictEqual(del[0].amount, 600000);
    assert.strictEqual((await master.call("PATCH", `/api/finance/${a.data.entry.id}`, { amount: 1 })).status, 404); // 삭제된 내역은 수정 불가
    assert.strictEqual((await master.call("POST", `/api/finance/${a.data.entry.id}/restore`)).status, 200);
    assert.strictEqual((await master.call("GET", "/api/finance?month=2026-11")).data.entries.length, 2);
    assert.strictEqual((await master.call("GET", "/api/finance/deleted")).data.entries.length, 0);
    await master.call("DELETE", `/api/finance/${a.data.entry.id}`);
    // 변경 기록(추가/수정/삭제/복구)과 전체 백업(삭제된 내역 포함)
    const log = (await master.call("GET", "/api/finance/log")).data.log;
    assert.deepStrictEqual(log.filter((x) => x.id === a.data.entry.id).map((x) => x.action).reverse(), ["create", "update", "delete", "restore", "delete"]);
    assert.strictEqual(log[0].by, "master");
    const raw = await fetch(base + "/api/finance/backup", { headers: { cookie: master.cookie() } });
    assert.match(raw.headers.get("content-disposition"), /finance-backup-\d{4}-\d{2}-\d{2}\.json/);
    const bk = await raw.json();
    assert.strictEqual(bk.entries.length, 3);
    assert.ok(bk.entries.some((e) => e.deletedAt));
    assert.strictEqual(bk.log.length, 7);
    assert.ok(fs.existsSync(path.join(dir, "finance-log.jsonl")));
    assert.ok(fs.readdirSync(path.join(dir, "finance-backups")).length >= 1); // 일일 스냅샷
    assert.strictEqual((await admin.call("GET", "/api/finance/backup")).status, 403);
    assert.strictEqual((await admin.call("GET", "/api/finance/log")).status, 403);
    assert.strictEqual((await admin.call("POST", `/api/finance/${a.data.entry.id}/restore`)).status, 403);

    // 분류/거래처 드롭다운 목록: 입력된 값으로 시작 + 추가/제거, 새 내역 값은 자동 등록
    const o0 = (await master.call("GET", "/api/finance/options")).data;
    assert.ok(o0.categories.includes("광고비") && o0.counterparties.length >= 0);
    assert.strictEqual((await master.call("POST", "/api/finance/options", { kind: "category", name: "인건비" })).status, 201);
    assert.strictEqual((await master.call("POST", "/api/finance/options", { kind: "counterparty", name: "병득" })).status, 201);
    assert.strictEqual((await master.call("POST", "/api/finance/options", { kind: "counterparty", name: "병득" })).status, 200); // 중복은 한 번만
    assert.strictEqual((await master.call("POST", "/api/finance/options", { kind: "x", name: "a" })).status, 400);
    assert.strictEqual((await admin.call("GET", "/api/finance/options")).status, 403);
    // 전월 대비: 인건비·병득 10월 6,000,000 → 11월 6,500,000 = +500,000
    await master.call("POST", "/api/finance", { type: "out", amount: 6000000, date: "2026-10-25", category: "인건비", counterparty: "병득" });
    await master.call("POST", "/api/finance", { type: "out", amount: 6500000, date: "2026-11-25", category: "인건비", counterparty: "병득" });
    await master.call("POST", "/api/finance", { type: "out", amount: 100000, date: "2026-11-26", category: "신규비용", counterparty: "A사" });
    const cmp = (await master.call("GET", "/api/finance?month=2026-11")).data.compare;
    assert.strictEqual(cmp.previousMonth, "2026-10");
    const pay = cmp.items.find((c) => c.category === "인건비" && c.counterparty === "병득");
    assert.deepStrictEqual([pay.previous, pay.current, pay.diff], [6000000, 6500000, 500000]);
    assert.strictEqual(cmp.items.find((c) => c.category === "신규비용").previous, 0);
    assert.strictEqual((await master.call("GET", "/api/finance?month=2027-01")).data.compare.previousMonth, "2026-12"); // 연도 경계
    assert.strictEqual((await master.call("GET", "/api/finance")).data.compare, null); // 전체 보기에는 비교 없음
    assert.ok((await master.call("GET", "/api/finance/options")).data.counterparties.includes("A사")); // 자동 등록
    const rm = await master.call("DELETE", "/api/finance/options?kind=counterparty&name=" + encodeURIComponent("A사"));
    assert.ok(!rm.data.counterparties.includes("A사"));
    assert.ok((await master.call("GET", "/api/finance?month=2026-11")).data.entries.some((e) => e.counterparty === "A사")); // 제거해도 내역은 유지

    // 영구 삭제: 삭제된 내역에서만 가능, 직전 백업 파일 + 기록이 남는다
    const x = (await master.call("POST", "/api/finance", { type: "out", amount: 777, date: "2026-11-27", category: "임시" })).data.entry;
    assert.strictEqual((await master.call("DELETE", `/api/finance/${x.id}/purge`)).status, 404); // 아직 삭제 전
    assert.strictEqual((await admin.call("DELETE", `/api/finance/${x.id}/purge`)).status, 403);
    await master.call("DELETE", `/api/finance/${x.id}`);
    assert.strictEqual((await master.call("DELETE", `/api/finance/${x.id}/purge`)).status, 200);
    assert.ok(!(await master.call("GET", "/api/finance/deleted")).data.entries.some((e) => e.id === x.id));
    assert.ok(fs.readdirSync(path.join(dir, "finance-backups")).some((f) => f.startsWith("finance-before-purge-")));
    assert.strictEqual((await master.call("GET", "/api/finance/log")).data.log[0].action, "purge");
    // 변경 기록 초기화: 기존 기록은 파일로 보관, 새 기록은 초기화 한 줄로 시작
    assert.strictEqual((await admin.call("POST", "/api/finance/log/reset")).status, 403);
    const before = (await master.call("GET", "/api/finance/log?limit=500")).data.log.length;
    const rs = await master.call("POST", "/api/finance/log/reset");
    assert.strictEqual(rs.data.cleared, before);
    const after = (await master.call("GET", "/api/finance/log")).data.log;
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].action, "log_reset");
    assert.ok(fs.readdirSync(path.join(dir, "finance-backups")).some((f) => f.startsWith("finance-log-")));
    assert.ok((await master.call("GET", "/api/finance?month=2026-11")).data.entries.length >= 2); // 내역 데이터는 그대로

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
