// 카페 댓글 체크 API: 추가/조회/수정/삭제 + 회원 차단 (네트워크 없는 CRUD만; 실제 조회는 배포에서)
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("카페 댓글 체크: CRUD + 회원 차단", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
  const port = 3700 + Math.floor(Math.random() * 300);
  // CAFE_COMMENT_AUTO=off: 등록 즉시 네트워크 조회를 건너뛴다(테스트 결정성)
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", CAFE_COMMENT_AUTO: "off", APP_PASSWORD: "adminpass123" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { let cookie = ""; return { call: async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const data = await r.json().catch(() => null); return { status: r.status, data }; } }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const admin = client();
    await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" });

    // 유효성: 검색어/작성자 필수, 주소는 카페 글이어야 함
    assert.strictEqual((await admin.call("POST", "/api/cafe-comments/items", { url: "cafe.naver.com/x/1", author: "애비수" })).status, 400); // 검색어 없음
    assert.strictEqual((await admin.call("POST", "/api/cafe-comments/items", { keyword: "난임", url: "https://example.com/x", author: "애비수" })).status, 400); // 카페 글 아님
    assert.strictEqual((await admin.call("POST", "/api/cafe-comments/items", { keyword: "난임", url: "cafe.naver.com/goondae/2715170" })).status, 400); // 작성자 없음

    const add = await admin.call("POST", "/api/cafe-comments/items", { keyword: "용종 미니보험", titleContains: "추천", url: "https://cafe.naver.com/goondae/2715170", author: "애비수" });
    assert.strictEqual(add.status, 201);
    const id = add.data.item.id;
    assert.ok(id);
    assert.strictEqual(add.data.item.keyword, "용종 미니보험");
    assert.strictEqual(add.data.item.author, "애비수");

    const list = await admin.call("GET", "/api/cafe-comments");
    assert.strictEqual(list.data.items.length, 1);

    // 수정
    assert.strictEqual((await admin.call("PATCH", "/api/cafe-comments/items/" + id, { author: "에비수", favorite: true })).data.item.author, "에비수");
    assert.strictEqual((await admin.call("GET", "/api/cafe-comments")).data.items[0].favorite, true);
    assert.strictEqual((await admin.call("PATCH", "/api/cafe-comments/items/" + id, { url: "https://example.com/x" })).status, 400); // 잘못된 주소
    assert.strictEqual((await admin.call("PATCH", "/api/cafe-comments/items/nope", { author: "x" })).status, 404);

    // 삭제
    assert.strictEqual((await admin.call("DELETE", "/api/cafe-comments/items/" + id)).data.removed, 1);
    assert.strictEqual((await admin.call("GET", "/api/cafe-comments")).data.items.length, 0);

    // 회원(viewer)은 전부 차단
    await admin.call("POST", "/api/projects", { name: "p" });
    await admin.call("POST", "/api/users", { username: "viewer1", password: "viewerpass1", tools: ["rank"] });
    const v = client();
    await v.call("POST", "/api/login", { username: "viewer1", password: "viewerpass1" });
    for (const [m, p, b] of [["GET", "/api/cafe-comments"], ["POST", "/api/cafe-comments/items", { keyword: "x", url: "cafe.naver.com/a/1", author: "y" }], ["POST", "/api/cafe-comments/run", {}], ["DELETE", "/api/cafe-comments/items/any"], ["GET", "/api/cafe-comments/debug?url=cafe.naver.com/a/1"]]) {
      assert.strictEqual((await v.call(m, p, b)).status, 403, `${m} ${p} 는 회원에게 막혀야 함`);
    }
  } finally { child.kill(); }
});
