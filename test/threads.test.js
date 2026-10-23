// Threads 연동 통합 테스트: 가짜 Threads(Graph) 서버로 OAuth 연결 → 게시글 등록 → 조회수 기록 → 회원 권한을 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function startMock() {
  let views = 100;
  const calls = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${u.pathname}`);
      const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (u.searchParams.get("access_token") === "BAD") return json({ error: { message: "expired", code: 190 } }, 400);
      if (u.pathname === "/oauth/access_token" && req.method === "POST") {
        const p = new URLSearchParams(body);
        return p.get("code") === "GOODCODE" && p.get("client_secret") === "sec" ? json({ access_token: "SHORT", user_id: "42" }) : json({ error: { message: "bad code" } }, 400);
      }
      if (u.pathname === "/access_token") return u.searchParams.get("access_token") === "SHORT" ? json({ access_token: "LONGTOKEN", expires_in: 5184000 }) : json({ error: { message: "bad" } }, 400);
      if (u.pathname === "/v1.0/me") return json({ id: "42", username: "lifeplanet_official" });
      if (u.pathname === "/v1.0/me/threads") {
        return u.searchParams.get("after") ? json({ data: [{ id: "M2", permalink: "https://www.threads.com/@lifeplanet_official/post/TargetPost1", text: "교보라이프플래닛 게시글", timestamp: "2026-10-20T01:00:00+0000" }] })
          : json({ data: [{ id: "M1", permalink: "https://www.threads.com/@lifeplanet_official/post/Other", text: "다른 글" }], paging: { next: `http://127.0.0.1:${srv.address().port}/v1.0/me/threads?after=X&access_token=LONGTOKEN` } });
      }
      const ins = /^\/v1\.0\/(M\d+)\/insights$/.exec(u.pathname);
      if (ins) { views += 25; return json({ data: [{ name: "views", values: [{ value: views }] }, { name: "likes", values: [{ value: 7 }] }, { name: "replies", values: [{ value: 2 }] }, { name: "reposts", values: [{ value: 1 }] }, { name: "quotes", values: [{ value: 0 }] }] }); }
      json({ error: { message: "not found" } }, 404);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}`, calls })));
}

test("Threads: 연결 → 게시글 등록 → 조회수 기록 → 회원 권한", async () => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-test-"));
  const port = 3800 + Math.floor(Math.random() * 400);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "adminpass123", THREADS_APP_ID: "appid", THREADS_APP_SECRET: "sec", THREADS_GRAPH_BASE: mock.base, THREADS_AUTH_BASE: "https://auth.example", THREADS_REDIRECT_URI: "https://site.example/api/threads/callback" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { let cookie = ""; return { cookie: () => cookie, call: async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; let data = null; try { data = await r.json(); } catch { /* */ } return { status: r.status, data, location: r.headers.get("location") }; } }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const admin = client();
    await admin.call("POST", "/api/login", { username: "admin", password: "adminpass123" });
    const pid = (await admin.call("POST", "/api/projects", { name: "교보라이프플래닛" })).data.id;
    const pid2 = (await admin.call("POST", "/api/projects", { name: "다른 프로젝트" })).data.id;

    // 연결 시작: 앱 ID/권한/콜백 주소/state 가 들어간 Meta 로그인 주소로 이동
    const c = await admin.call("GET", `/api/threads/connect?projectId=${pid}`);
    assert.strictEqual(c.status, 302);
    const loc = new URL(c.location);
    assert.strictEqual(loc.origin + loc.pathname, "https://auth.example/oauth/authorize");
    assert.strictEqual(loc.searchParams.get("client_id"), "appid");
    assert.strictEqual(loc.searchParams.get("redirect_uri"), "https://site.example/api/threads/callback");
    assert.match(loc.searchParams.get("scope"), /threads_manage_insights/);
    const state = loc.searchParams.get("state");

    // 잘못된 state 는 거절, 올바른 코드는 계정 저장
    assert.match((await admin.call("GET", "/api/threads/callback?code=GOODCODE&state=forged.sig")).location, /error=/);
    const cb = await admin.call("GET", `/api/threads/callback?code=GOODCODE%23_&state=${encodeURIComponent(state)}`);
    assert.match(cb.location, /connected=lifeplanet_official/);
    const list0 = (await admin.call("GET", `/api/threads?projectId=${pid}`)).data;
    assert.strictEqual(list0.accounts[0].username, "lifeplanet_official");
    assert.ok(!JSON.stringify(list0).includes("LONGTOKEN"), "토큰은 응답에 나가면 안 됨");

    // 게시글 등록(두 번째 페이지에서 찾음) → 첫 조회수 기록
    assert.strictEqual((await admin.call("POST", "/api/threads/posts", { projectId: pid, url: "https://example.com/x" })).status, 400);
    assert.strictEqual((await admin.call("POST", "/api/threads/posts", { projectId: pid2, url: "https://www.threads.com/@a/post/TargetPost1" })).status, 400); // 계정 없는 프로젝트
    assert.strictEqual((await admin.call("POST", "/api/threads/posts", { projectId: pid, url: "https://www.threads.com/@lifeplanet_official/post/NoSuchPost" })).status, 404);
    const add = await admin.call("POST", "/api/threads/posts", { projectId: pid, url: "https://www.threads.com/@lifeplanet_official/post/TargetPost1?x=1" });
    assert.strictEqual(add.status, 201);
    assert.strictEqual((await admin.call("POST", "/api/threads/posts", { projectId: pid, url: "https://www.threads.com/@lifeplanet_official/post/TargetPost1" })).status, 409);
    const p = (await admin.call("GET", `/api/threads?projectId=${pid}`)).data.posts[0];
    const day = Object.keys(p.history)[0];
    assert.strictEqual(p.history[day].views, 125);
    assert.strictEqual(p.history[day].likes, 7);

    // 다시 조회하면 같은 날 기록이 갱신됨
    assert.strictEqual((await admin.call("POST", "/api/threads/run", { postId: p.id })).data.ok, 1);
    assert.strictEqual((await admin.call("GET", `/api/threads?projectId=${pid}`)).data.posts[0].history[day].views, 150);

    // 회원: 자기 프로젝트의 Threads 데이터만 읽기, 쓰기/연결은 불가
    await admin.call("POST", "/api/users", { username: "kyobo", password: "kyobopass1", projectIds: [pid] });
    const v = client();
    await v.call("POST", "/api/login", { username: "kyobo", password: "kyobopass1" });
    assert.strictEqual((await v.call("GET", `/api/threads?projectId=${pid}`)).data.posts.length, 1);
    assert.strictEqual((await v.call("GET", `/api/threads?projectId=${pid2}`)).status, 403);
    for (const [m, u, b] of [["POST", "/api/threads/run", { projectId: pid }], ["POST", "/api/threads/posts", { projectId: pid, url: "x" }], ["DELETE", `/api/threads/posts/${p.id}`], ["GET", `/api/threads/connect?projectId=${pid}`], ["GET", "/api/threads/config"], ["DELETE", "/api/threads/accounts/x"]]) assert.strictEqual((await v.call(m, u, b)).status, 403, `${m} ${u}`);
    assert.strictEqual((await v.call("GET", "/threads.html")).status, 200);
    assert.strictEqual((await v.call("GET", "/home.html")).status, 200);
  } finally { child.kill(); mock.srv.close(); }
});

test("Threads: 환경 변수가 없으면 연결/등록이 막히고 안내만 보인다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-test2-"));
  const port = 4300 + Math.floor(Math.random() * 400);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "adminpass123", THREADS_APP_ID: "", THREADS_APP_SECRET: "" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "adminpass123" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const get = (p) => fetch(base + p, { headers: { cookie }, redirect: "manual" });
    assert.strictEqual((await (await get("/api/threads?projectId=x")).json()).configured, false);
    assert.strictEqual((await get("/api/threads/connect?projectId=x")).status, 400);
  } finally { child.kill(); }
});

test("Threads: OAuth 설정 없이 액세스 토큰만으로 연결 → 등록 → 조회수 기록", async () => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-test3-"));
  const port = 4800 + Math.floor(Math.random() * 400);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "adminpass123", THREADS_APP_ID: "", THREADS_APP_SECRET: "", THREADS_GRAPH_BASE: mock.base }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; let data = null; try { data = await r.json(); } catch { /* */ } return { status: r.status, data }; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await call("POST", "/api/login", { username: "admin", password: "adminpass123" });
    const pid = (await call("POST", "/api/projects", { name: "교보라이프플래닛" })).data.id;
    assert.strictEqual((await call("POST", "/api/threads/accounts/token", { projectId: pid, token: "short" })).status, 400);
    assert.strictEqual((await call("POST", "/api/threads/accounts/token", { projectId: pid, token: "BAD" })).status, 400);
    const ok = await call("POST", "/api/threads/accounts/token", { projectId: pid, token: "LONGTOKEN-abcdefghijklmnop" });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.data.username, "lifeplanet_official");
    const list = (await call("GET", `/api/threads?projectId=${pid}`)).data;
    assert.strictEqual(list.accounts.length, 1);
    assert.ok(!JSON.stringify(list).includes("LONGTOKEN"), "토큰은 응답에 나가면 안 됨");
    // OAuth 앱 설정이 없어도 게시글 등록/조회가 된다
    const add = await call("POST", "/api/threads/posts", { projectId: pid, url: "https://www.threads.com/@lifeplanet_official/post/TargetPost1" });
    assert.strictEqual(add.status, 201);
    const p = (await call("GET", `/api/threads?projectId=${pid}`)).data.posts[0];
    assert.strictEqual(Object.values(p.history)[0].views, 125);
    assert.strictEqual((await call("POST", "/api/threads/run", { postId: p.id })).data.ok, 1);
    // 같은 계정을 다시 붙여넣어도 중복 계정이 생기지 않는다
    await call("POST", "/api/threads/accounts/token", { projectId: pid, token: "LONGTOKEN-abcdefghijklmnop" });
    assert.strictEqual((await call("GET", `/api/threads?projectId=${pid}`)).data.accounts.length, 1);
  } finally { child.kill(); mock.srv.close(); }
});
