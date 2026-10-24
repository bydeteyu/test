// Chrome 확장 프로그램 통합 테스트: 진짜 Chromium 에 확장 프로그램을 설치하고, 가짜 Threads 글 화면을 열어 숫자를 읽어 서버에 기록하는지 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("확장 프로그램: 등록된 글을 열어 조회수·좋아요·댓글을 읽어 서버에 기록한다", async (t) => {
  const exe = process.env.CHROMIUM_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium"].find((f) => fs.existsSync(f));
  let chromium;
  try { ({ chromium } = require("playwright-core")); } catch { return t.skip("playwright-core 없음"); }
  if (!exe) return t.skip("Chromium 없음");

  // 가짜 Threads: 로그인된 화면(글 + 아래 버튼 줄)을 자바스크립트로 그린다
  // 실제 화면처럼 글 아래 아이콘에는 이름표가 없고, 숫자는 아이콘 옆 글자이며, 왼쪽 메뉴 아이콘에만 이름표가 있다
  const ic = (l) => `<svg ${l ? `aria-label="${l}"` : ""} viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M1 1h10v10H1z"/></svg>`;
  const bar = (a) => `<div style="display:flex;gap:18px;align-items:center;margin:8px 0">${a.map((n) => `<div style="display:flex;gap:4px;align-items:center"><div role="button">${ic("")}</div>${n != null ? `<span>${n}</span>` : ""}</div>`).join("")}</div>`;
  const inner = `<div style="position:fixed;left:0;top:0;width:200px">${["Threads", "홈", "검색", "메시지", "알림", "프로필", "인사이트", "저장됨", "좋아요"].map((l) => `<div style="margin:12px">${ic(l)} ${l}</div>`).join("")}</div><div style="margin-left:400px;width:520px"><h2>스레드</h2><div>조회 ${"3"}07회</div><div style="display:flex;justify-content:space-between"><b>user</b>${ic("더 보기")}</div><p>본문 글입니다</p>${bar([2, 3, null, null])}<hr><div>${ic("정렬")} 인기순</div><hr><div><b>bbs</b> 나오지</div>${bar([null, null, null, null])}</div>`;
  const web = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body><div id="r">로딩…</div><script>setTimeout(()=>{document.getElementById("r").innerHTML=new TextDecoder().decode(Uint8Array.from(atob("${Buffer.from(inner).toString("base64")}"),(c)=>c.charCodeAt(0)))},500)</script></body></html>`);
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));

  // 테스트용 확장 프로그램 사본: 가짜 Threads(127.0.0.1) 접근 권한만 추가
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-"));
  for (const f of fs.readdirSync(path.join(__dirname, "..", "extension"))) fs.copyFileSync(path.join(__dirname, "..", "extension", f), path.join(extDir, f));
  const mf = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf-8"));
  mf.host_permissions.push("http://127.0.0.1/*");
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(mf));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-ext-"));
  const port = 7300 + Math.floor(Math.random() * 400);
  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, RANK_AUTO: "off", APP_PASSWORD: "adminpass123", THREADS_WEB_ALLOW: "127.0.0.1", THREADS_BROWSER: "off" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc && p === "/api/login") cookie = sc.split(";")[0]; let data = null; try { data = await r.json(); } catch { /* */ } return { status: r.status, data }; };
  let ctx;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/healthz"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await call("POST", "/api/login", { username: "admin", password: "adminpass123" });
    const pid = (await call("POST", "/api/projects", { name: "p" })).data.id;
    const key = (await call("GET", "/api/threads/ext-key")).data.key;
    const add = await call("POST", "/api/threads/posts", { projectId: pid, url: `http://127.0.0.1:${web.address().port}/@a/post/ExtE2E1` });
    assert.strictEqual(add.status, 201);

    ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "ud-")), { executablePath: exe, headless: true, args: ["--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--headless=new"] });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    await sw.evaluate(([server, k]) => chrome.storage.local.set({ server, key: k }), [base, key]);
    sw.evaluate(() => run()).catch(() => {}); // 설치 직후 자동 실행과 겹치면 busy 로 끝나므로 결과는 서버 기록으로 확인한다
    let p = null;
    for (let i = 0; i < 60; i++) {
      p = (await call("GET", `/api/threads?projectId=${pid}`)).data.posts[0];
      if (p.extAt) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(p && p.extAt, "확장 프로그램이 숫자를 보내지 않았습니다");
    assert.deepStrictEqual(Object.values(p.history)[0], { views: 307, likes: 2, replies: 3, reposts: 0, shares: 0 });
    assert.ok(p.extAt);
  } finally { if (ctx) await ctx.close().catch(() => {}); child.kill(); web.close(); }
});
