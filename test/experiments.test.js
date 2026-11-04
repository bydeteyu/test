// 실험 노트 API 통합 테스트: 추가 → 조회 → 수정 → CSV 내보내기 → 삭제, 그리고 회원(viewer) 권한 차단.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("실험 노트: 추가/수정/CSV/삭제 + 회원 차단", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-test-"));
  const port = 3300 + Math.floor(Math.random() * 400);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "adminpass123" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { let cookie = ""; return { call: async (m, p, b, raw = false) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const data = raw === "buf" ? Buffer.from(await r.arrayBuffer()) : raw ? await r.text() : await r.json().catch(() => null); return { status: r.status, data }; } }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

    const admin = client();
    await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" });

    // 추가: 날짜 비우면 오늘(KST)로 채워지고, 입력한 값이 저장된다
    const add = await admin.call("POST", "/api/experiments", { author: "병득", category: "스레드", hypothesis: "퇴근시간 조회수가 높을 것", result: "9시 400" });
    assert.strictEqual(add.status, 200);
    const id = add.data.item.id;
    assert.ok(id);
    assert.match(add.data.item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(add.data.item.category, "스레드");

    // 조회
    const list = await admin.call("GET", "/api/experiments");
    assert.strictEqual(list.data.items.length, 1);
    assert.strictEqual(list.data.items[0].hypothesis, "퇴근시간 조회수가 높을 것");

    // 수정
    const patch = await admin.call("PATCH", "/api/experiments/" + id, { judgment: "모수 적어 판단 이름" });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.data.item.judgment, "모수 적어 판단 이름");

    // CSV 내보내기: BOM(엑셀 한글 깨짐 방지) + 헤더 + 값
    const csvBuf = await admin.call("GET", "/api/experiments/export.csv", null, "buf");
    assert.strictEqual(csvBuf.status, 200);
    assert.deepStrictEqual([...csvBuf.data.slice(0, 3)], [0xEF, 0xBB, 0xBF], "UTF-8 BOM");
    const csvText = csvBuf.data.toString("utf-8");
    assert.match(csvText, /날짜","작성자","분류/);
    assert.match(csvText, /스레드/);
    assert.match(csvText, /모수 적어 판단 이름/);

    // 없는 항목 수정 → 404
    assert.strictEqual((await admin.call("PATCH", "/api/experiments/nope", { author: "x" })).status, 404);

    // 삭제
    assert.strictEqual((await admin.call("DELETE", "/api/experiments/" + id)).data.removed, 1);
    assert.strictEqual((await admin.call("GET", "/api/experiments")).data.items.length, 0);

    // 회원(viewer): 모든 실험 노트 API 차단(403)
    await admin.call("POST", "/api/users", { username: "member", password: "memberpass1", projectIds: [] });
    const v = client();
    await v.call("POST", "/api/login", { username: "member", password: "memberpass1" });
    for (const [m, u, b] of [["GET", "/api/experiments"], ["POST", "/api/experiments", { author: "x" }], ["PATCH", "/api/experiments/any", { author: "x" }], ["DELETE", "/api/experiments/any"], ["GET", "/api/experiments/export.csv"]]) {
      assert.strictEqual((await v.call(m, u, b)).status, 403, `${m} ${u}`);
    }
  } finally { child.kill(); }
});
