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
    const patch = await admin.call("PATCH", "/api/experiments/" + id, { nextStep: "대조군 샘플 확보" });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.data.item.nextStep, "대조군 샘플 확보");

    // CSV 내보내기: BOM(엑셀 한글 깨짐 방지) + 헤더 + 값
    const csvBuf = await admin.call("GET", "/api/experiments/export.csv", null, "buf");
    assert.strictEqual(csvBuf.status, 200);
    assert.deepStrictEqual([...csvBuf.data.slice(0, 3)], [0xEF, 0xBB, 0xBF], "UTF-8 BOM");
    const csvText = csvBuf.data.toString("utf-8");
    assert.match(csvText, /날짜","작성자","분류/);
    assert.match(csvText, /스레드/);
    assert.match(csvText, /대조군 샘플 확보/);
    assert.doesNotMatch(csvText, /판단/);

    // 코멘트: 등록 → 조회에 포함 → 삭제
    const addc = await admin.call("POST", "/api/experiments/" + id + "/comments", { author: "동료A", text: "이 가설 좋네요" });
    assert.strictEqual(addc.status, 200);
    assert.strictEqual(addc.data.comments.length, 1);
    const cid = addc.data.comment.id;
    assert.strictEqual((await admin.call("POST", "/api/experiments/" + id + "/comments", { text: "" })).status, 400);
    assert.strictEqual((await admin.call("GET", "/api/experiments")).data.items[0].comments[0].text, "이 가설 좋네요");
    assert.strictEqual((await admin.call("DELETE", "/api/experiments/" + id + "/comments/" + cid)).data.comments.length, 0);

    // 백업(JSON): 그대로 되돌릴 수 있는 형식
    const backup = await admin.call("GET", "/api/experiments/backup.json");
    assert.strictEqual(backup.status, 200);
    assert.strictEqual(backup.data.items.length, 1);
    assert.strictEqual(backup.data.items[0].id, id);

    // 복원(merge): 같은 id는 건너뛰고(중복 추가 0), 새 id만 추가
    const imp0 = await admin.call("POST", "/api/experiments/import", { items: backup.data.items });
    assert.strictEqual(imp0.data.added, 0);
    assert.strictEqual(imp0.data.total, 1);
    const imp1 = await admin.call("POST", "/api/experiments/import", { items: [{ author: "복원된사람", hypothesis: "복원 테스트" }] });
    assert.strictEqual(imp1.data.added, 1);
    assert.strictEqual((await admin.call("GET", "/api/experiments")).data.items.length, 2);

    // 저장 상태
    assert.strictEqual(typeof (await admin.call("GET", "/api/experiments/storage")).data.persistent, "boolean");

    // 없는 항목 수정 → 404
    assert.strictEqual((await admin.call("PATCH", "/api/experiments/nope", { author: "x" })).status, 404);

    // 삭제: 원본 id 제거 → 복원으로 추가된 1건만 남음
    assert.strictEqual((await admin.call("DELETE", "/api/experiments/" + id)).data.removed, 1);
    assert.strictEqual((await admin.call("GET", "/api/experiments")).data.items.length, 1);

    // 회원(viewer): 모든 실험 노트 API 차단(403)
    await admin.call("POST", "/api/users", { username: "member", password: "memberpass1", projectIds: [] });
    const v = client();
    await v.call("POST", "/api/login", { username: "member", password: "memberpass1" });
    for (const [m, u, b] of [["GET", "/api/experiments"], ["POST", "/api/experiments", { author: "x" }], ["PATCH", "/api/experiments/any", { author: "x" }], ["DELETE", "/api/experiments/any"], ["GET", "/api/experiments/export.csv"], ["GET", "/api/experiments/backup.json"], ["POST", "/api/experiments/import", { items: [] }], ["GET", "/api/experiments/storage"], ["POST", "/api/experiments/any/comments", { text: "x" }], ["DELETE", "/api/experiments/any/comments/any"]]) {
      assert.strictEqual((await v.call(m, u, b)).status, 403, `${m} ${u}`);
    }
  } finally { child.kill(); }
});
