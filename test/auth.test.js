// 로그인/권한 통합 테스트: 서버를 실제로 띄워 관리자·회원 접근 범위를 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function start(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  const port = 3300 + Math.floor(Math.random() * 500);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "", ...env }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => { for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error("server did not start"); })();
  return { base, ready, stop: () => child.kill(), dir };
}
const client = (base) => {
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    let data = null; try { data = await r.json(); } catch { /* 본문 없음 */ }
    return { status: r.status, data, location: r.headers.get("location") };
  };
  return { call, cookie: () => cookie, clear: () => (cookie = "") };
};

test("관리자/회원 권한", async () => {
  const s = start({ APP_PASSWORD: "adminpass123" });
  try {
    await s.ready;
    const anon = client(s.base);
    assert.strictEqual((await anon.call("GET", "/api/rank")).status, 401);
    assert.strictEqual((await anon.call("GET", "/rank.html")).location.startsWith("/login.html"), true);
    assert.strictEqual((await anon.call("POST", "/api/login", { username: "admin", password: "x" })).status, 401);

    const admin = client(s.base);
    assert.strictEqual((await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" })).status, 200);
    assert.strictEqual((await admin.call("GET", "/api/me")).data.role, "admin");
    const p1 = (await admin.call("POST", "/api/projects", { name: "교보라이프플래닛" })).data.id;
    const p2 = (await admin.call("POST", "/api/projects", { name: "윤후여성한의원" })).data.id;
    await admin.call("POST", "/api/rank/items", { projectId: p1, keyword: "k1", titleContains: "a" });
    await admin.call("POST", "/api/rank/items", { projectId: p2, keyword: "k2", titleContains: "b" });
    assert.strictEqual((await admin.call("POST", "/api/users", { username: "short", password: "1234" })).status, 400);
    assert.strictEqual((await admin.call("POST", "/api/users", { username: "kyobo", password: "kyobopass1", name: "교보", projectIds: [p1] })).status, 201);
    assert.strictEqual((await admin.call("POST", "/api/users", { username: "kyobo", password: "kyobopass1" })).status, 409);
    assert.strictEqual((await admin.call("POST", "/api/users", { username: "admin", password: "kyobopass1" })).status, 409);
    assert.ok(!JSON.stringify((await admin.call("GET", "/api/users")).data).includes("hash"));

    const v = client(s.base);
    assert.strictEqual((await v.call("POST", "/api/login", { username: "kyobo", password: "wrong" })).status, 401);
    assert.strictEqual((await v.call("POST", "/api/login", { username: "kyobo", password: "kyobopass1" })).data.role, "viewer");
    const names = (await v.call("GET", "/api/projects")).data.map((p) => p.name);
    assert.deepStrictEqual(names, ["교보라이프플래닛"]);
    const ok = await v.call("GET", `/api/rank?projectId=${p1}`);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.data.items.map((i) => i.keyword), ["k1"]);
    assert.strictEqual((await v.call("GET", `/api/rank?projectId=${p2}`)).status, 403);
    assert.strictEqual((await v.call("GET", "/api/rank")).data.items.length, 1); // 프로젝트가 하나면 자동 지정
    for (const [m, p, b] of [["POST", "/api/rank/run", { projectId: p1 }], ["POST", "/api/rank/items", { projectId: p1, keyword: "x", titleContains: "y" }], ["DELETE", "/api/rank/items/abc"], ["POST", "/api/rank/search", { keywords: "x" }], ["GET", "/api/users"], ["POST", "/api/users", { username: "evil", password: "evilpass1" }], ["GET", "/api/keywords"], ["POST", "/api/projects", { name: "x" }], ["DELETE", `/api/projects/${p1}`], ["GET", "/api/rank/export"], ["POST", "/api/rank/import", {}], ["GET", "/api/rank/debug?keyword=x"], ["GET", "/api/rank/snapshots"], ["POST", "/api/monitor/run", {}]]) {
      assert.strictEqual((await v.call(m, p, b)).status, 403, `${m} ${p} 는 회원에게 막혀야 함`);
    }
    // 엑셀 다운로드: 회원은 자기 프로젝트만
    const x = await fetch(`${s.base}/api/rank/xlsx?projectId=${p1}`, { headers: { cookie: v.cookie() } });
    assert.strictEqual(x.status, 200);
    assert.match(x.headers.get("content-type"), /spreadsheetml/);
    assert.strictEqual(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), "PK");
    assert.strictEqual((await v.call("GET", `/api/rank/xlsx?projectId=${p2}`)).status, 403);
    assert.strictEqual((await v.call("GET", "/api/rank/xlsx")).status, 200); // 프로젝트가 하나면 자동 지정
    assert.strictEqual((await v.call("GET", "/")).location, "/rank.html");
    assert.strictEqual((await v.call("GET", "/admin.html")).location, "/rank.html");
    assert.strictEqual((await v.call("GET", "/rank.html")).status, 200);

    // 비밀번호를 바꾸면 기존 세션이 끊긴다
    const id = (await admin.call("GET", "/api/users")).data.users[0].id;
    assert.strictEqual((await admin.call("PATCH", `/api/users/${id}`, { password: "newpass1234" })).status, 200);
    assert.strictEqual((await v.call("GET", "/api/projects")).status, 401);
    // 프로젝트를 삭제하면 계정 연결도 정리된다
    assert.strictEqual((await admin.call("DELETE", `/api/projects/${p1}`)).status, 200);
    assert.deepStrictEqual((await admin.call("GET", "/api/users")).data.users[0].projectIds, []);
    // 계정 삭제
    assert.strictEqual((await admin.call("DELETE", `/api/users/${id}`)).status, 200);
    assert.strictEqual((await v.call("POST", "/api/login", { username: "kyobo", password: "newpass1234" })).status, 401);
  } finally { s.stop(); }
});

test("APP_PASSWORD 없이(열린 상태)는 계정을 만들 수 없다", async () => {
  const s = start({});
  try {
    await s.ready;
    const c = client(s.base);
    assert.strictEqual((await c.call("GET", "/api/me")).data.openMode, true);
    assert.strictEqual((await c.call("POST", "/api/users", { username: "someone", password: "password123" })).status, 400);
  } finally { s.stop(); }
});
