// Threads(Meta) 게시글 조회수 추적. 공식 Threads API 만 사용한다 — 계정 소유자가 OAuth 로 허용한 계정의 게시글만 읽을 수 있다.
//  1) 프로젝트에 Threads 계정을 연결(OAuth)  2) 게시글 주소를 등록  3) 매일 조회수·좋아요·댓글 등을 기록
// 환경 변수: THREADS_APP_ID, THREADS_APP_SECRET (Meta 개발자 앱), THREADS_REDIRECT_URI(선택, 기본은 현재 주소 + /api/threads/callback)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APP_ID = process.env.THREADS_APP_ID || "";
const APP_SECRET = process.env.THREADS_APP_SECRET || "";
const GRAPH = process.env.THREADS_GRAPH_BASE || "https://graph.threads.net"; // 테스트용 override
const AUTH_BASE = process.env.THREADS_AUTH_BASE || "https://threads.net";
const SCOPES = "threads_basic,threads_manage_insights";
const METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];
const AUTO_HOUR = Number(process.env.RANK_AUTO_HOUR || 9); // 순위 체크와 같은 시각(KST)
const KEEP_DAYS = 400;
// 공개 게시글 페이지 읽기: 허용 호스트(서버가 임의 주소를 열지 못하게 제한). 테스트에서만 THREADS_WEB_ALLOW 로 추가한다.
const WEB_HOSTS = ["threads.com", "www.threads.com", "threads.net", "www.threads.net", ...String(process.env.THREADS_WEB_ALLOW || "").split(",").filter(Boolean)];
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// "57", "1,234", "1.2천", "3.4만", "1.2K", "2M" → 숫자
function toCount(num, unit) {
  const n = parseFloat(String(num).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mul = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, m: 1e6 }[String(unit || "").toLowerCase()] || 1;
  return Math.round(n * mul);
}
// 공개 게시글 페이지(HTML)에서 조회수를 찾는다. "조회 57회" / "57 views" / 내장 JSON 의 view_count 순으로 시도.
function parseViews(html) {
  const t = String(html || "");
  let m = /조회\s*(?:수\s*)?([\d][\d,.]*)\s*(천|만|억|[KkMm])?\s*회/.exec(t) || /(?:조회수?\s*)([\d][\d,.]*)\s*(천|만|억|[KkMm])?(?![\d,.]*\s*(?:개|명))/.exec(t);
  if (m) return toCount(m[1], m[2]);
  m = /([\d][\d,.]*)\s*([KkMm])?\s*views?\b/i.exec(t);
  if (m) return toCount(m[1], m[2]);
  m = /"(?:view_count|views_count|impression_count)"\s*:\s*(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}
const metaOf = (html, prop) => {
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i").exec(html) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i").exec(html);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : "";
};
// Threads 페이지는 글·조회수를 자바스크립트로 나중에 채우므로, 단순 요청으로 못 읽으면 가상 브라우저(Chromium)로 열어 화면에 보이는 글자를 읽는다.
// 한 번에 하나씩만 열어 메모리를 아낀다. THREADS_BROWSER=off 로 끌 수 있고, 실행 파일 위치는 CHROMIUM_PATH(기본 /usr/bin/chromium).
// 화면 글자에서 게시글 본문을 고른다: 아이디·시간·"조회 N회"·메뉴 같은 줄은 건너뛰고 처음 나오는 문장형 줄
function bodyOf(t) {
  const skip = /^[\w.]+$|^\d+\s*(초|분|시간|일|주)|조회|^스레드$|^(추천|검색|메시지|활동|프로필|인사이트|팔로우|팔로잉|저장됨|좋아요|보관함|답글|공유|더 보기|\d+)$/;
  return String(t || "").split("\n").map((x) => x.trim()).find((x) => x.length >= 8 && !skip.test(x) && /[^\x00-\x7F]|\s/.test(x))?.slice(0, 200) || "";
}
let browserQueue = Promise.resolve();
function browserText(url) {
  const job = browserQueue.then(async () => {
    if (process.env.THREADS_BROWSER === "off") throw new Error("가상 브라우저가 꺼져 있습니다");
    let chromium;
    try { ({ chromium } = require("playwright-core")); } catch { throw new Error("가상 브라우저(playwright-core)가 설치되어 있지 않습니다"); }
    const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    try {
      const ctx = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul", userAgent: WEB_UA, viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForFunction(() => /조회\s*\d|\d\s*views?\b/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      // 글 아래 버튼(좋아요·답글·리포스트·공유)은 아이콘(svg aria-label) + 숫자 글자. 화면 맨 위(본문)의 첫 번째 것을 읽고, 숫자가 안 보이면 0.
      const acts = await page.evaluate(() => {
        const KEYS = { likes: /^(좋아요|좋아요 취소|likes?|unlike)$/i, replies: /^(답글|댓글|reply|comment)$/i, reposts: /^(리포스트|repost)$/i, shares: /^(공유|공유하기|share)$/i };
        const labelOf = (svg) => (svg.getAttribute("aria-label") || "").trim();
        const all = [...document.querySelectorAll("svg[aria-label]")];
        const labels = [...new Set(all.map(labelOf))].slice(0, 40);
        // 왼쪽 메뉴에도 "좋아요" 아이콘이 있으므로, 좋아요·답글 아이콘이 함께 들어 있는 작은 줄(글 아래 버튼 줄)을 찾는다
        let row = null;
        for (const svg of all.filter((x) => KEYS.likes.test(labelOf(x)))) {
          let el = svg;
          for (let i = 0; i < 8 && el && !row; i++) {
            el = el.parentElement;
            if (el && [...el.querySelectorAll("svg[aria-label]")].some((x) => KEYS.replies.test(labelOf(x))) && el.getBoundingClientRect().height < 100) row = el;
          }
          if (row) break;
        }
        const out = {};
        if (row) {
          for (const [k, re] of Object.entries(KEYS)) {
            const svg = [...row.querySelectorAll("svg[aria-label]")].find((x) => re.test(labelOf(x)));
            if (!svg) continue;
            const btn = svg.closest('[role="button"]');
            let el = btn || svg.parentElement, txt = el ? el.innerText || "" : "";
            for (let i = 0; !btn && i < 2 && el !== row && el && !/\d/.test(txt); i++) { el = el.parentElement; txt = el ? el.innerText || "" : ""; }
            const m = /([\d][\d,.]*)\s*(천|만|억|[KkMm])?/.exec(txt);
            out[k] = m ? [m[1], m[2] || ""] : [null, ""];
          }
        }
        return { out, seen: labels, bar: row ? row.outerHTML.slice(0, 1500) : null };
      });
      const counts = {};
      for (const [k, [n, u]] of Object.entries(acts.out)) counts[k] = n == null ? 0 : toCount(n, u);
      return { text: await page.evaluate(() => document.body.innerText), title: await page.title(), counts, seen: acts.seen, bar: acts.bar };
    } finally { await browser.close().catch(() => {}); }
  });
  browserQueue = job.catch(() => {});
  return job;
}
async function fetchPublic(url) {
  const u = new URL(url);
  if (!WEB_HOSTS.includes(u.hostname)) throw new Error("Threads 게시글 주소가 아닙니다.");
  const res = await fetch(u, { headers: { "User-Agent": WEB_UA, "Accept-Language": "ko-KR,ko;q=0.9", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`공개 페이지를 열지 못했습니다(HTTP ${res.status}). 숫자를 직접 입력할 수 있습니다.`);
  const html = await res.text();
  let views = parseViews(html), counts = {}, text = (metaOf(html, "og:description") || metaOf(html, "og:title")).slice(0, 200), why = "";
  if (views == null) {
    try {
      const b = await browserText(u.href);
      views = parseViews(b.text);
      counts = b.counts || {};
      if (!text) text = bodyOf(b.text);
    } catch (e) { why = ` · 브라우저 읽기 실패: ${e.message.split("\n")[0].slice(0, 120)}`; }
  }
  if (views == null) throw new Error(`공개 페이지에서 조회수를 찾지 못했습니다(로그인이 필요하거나 화면 구조가 다릅니다${why}). 숫자를 직접 입력할 수 있습니다.`);
  return { views, text, counts };
}

// 공유 링크(/share/코드)는 게시글 주소(/@계정/post/코드)로 이동하는 짧은 주소 → 따라가서 실제 주소를 얻는다
async function resolveShare(url) {
  let u;
  try { u = new URL(String(url || "").trim()); } catch { return url; }
  if (!WEB_HOSTS.includes(u.hostname) || !/^\/share\//.test(u.pathname)) return url;
  try {
    const res = await fetch(u, { headers: { "User-Agent": WEB_UA, "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const m = /\/post\/[A-Za-z0-9_-]+/.exec(res.url) || /\/@[\w.]+\/post\/[A-Za-z0-9_-]+/.exec(await res.text().catch(() => ""));
    if (/\/post\//.test(res.url)) return res.url;
    return m ? new URL(m[0], u.origin).href : url;
  } catch { return url; }
}

function mount(app, { dataDir }) {
  const file = path.join(dataDir, "threads.json");
  const load = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : { accounts: [], posts: [], meta: {} };
  };
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 }); // 토큰이 들어 있어 소유자만 읽게 한다
  const configured = () => !!(APP_ID && APP_SECRET);
  const redirectUri = (req) => process.env.THREADS_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/threads/callback`;
  const stateKey = () => crypto.createHash("sha256").update("threads-state:" + APP_SECRET).digest();
  const sign = (s) => crypto.createHmac("sha256", stateKey()).update(s).digest("base64url");
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));
  const needConfig = (req, res, next) => (configured() ? next() : res.status(400).json({ error: "not_configured", message: "서버 환경 변수 THREADS_APP_ID / THREADS_APP_SECRET 이 설정되어 있지 않습니다." }));

  async function graph(method, url, params = {}) {
    const isGet = method === "GET";
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(isGet ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url, {
      method,
      headers: isGet ? {} : { "Content-Type": "application/x-www-form-urlencoded" },
      body: isGet ? undefined : qs,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, code: data?.error?.code });
    }
    return data;
  }

  // ---- 게시글 주소 → 게시글 ID ----
  const shortcodeOf = (url) => (/\/post\/([A-Za-z0-9_-]+)/.exec(String(url || "")) || [])[1] || null;
  async function findMedia(account, shortcode) {
    let next = `${GRAPH}/v1.0/me/threads`;
    let params = { fields: "id,permalink,text,timestamp", limit: "100", access_token: account.token };
    for (let page = 0; page < 20 && next; page++) {
      const d = await graph("GET", next, params);
      const hit = (d.data || []).find((m) => shortcodeOf(m.permalink) === shortcode);
      if (hit) return hit;
      next = d.paging?.next || null;
      params = {}; // next 주소에 이미 모든 값이 들어 있다
    }
    return null;
  }

  // ---- 조회수 기록 ----
  const metricValue = (m) => (m.values && m.values[0] ? m.values[0].value : m.total_value ? m.total_value.value : null);
  async function fetchInsights(account, mediaId) {
    const d = await graph("GET", `${GRAPH}/v1.0/${mediaId}/insights`, { metric: METRICS.join(","), access_token: account.token });
    const out = {};
    for (const m of d.data || []) if (METRICS.includes(m.name)) out[m.name] = metricValue(m);
    return out;
  }
  async function refreshPost(db, post) {
    if (post.source === "public") {
      try {
        const r = await fetchPublic(post.url);
        const h = (post.history ??= {});
        h[today()] = { ...(h[today()] || {}), views: r.views, ...r.counts }; // 확장 프로그램이 기록한 좋아요·댓글을 지우지 않는다
        if ((!post.text || /^[\w.]+$/.test(post.text)) && r.text) post.text = r.text; // 예전에 아이디가 제목으로 잡힌 글도 고친다
        post.lastError = null;
        return true;
      } catch (e) { post.lastError = e.name === "TimeoutError" ? "공개 페이지 응답 시간이 초과되었습니다" : e.message; return false; }
    }
    const acc = db.accounts.find((a) => a.id === post.accountId);
    if (!acc) { post.lastError = "연결된 계정이 없습니다"; return false; }
    try {
      const ins = await fetchInsights(acc, post.mediaId);
      (post.history ??= {})[today()] = ins;
      const dates = Object.keys(post.history).sort();
      for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete post.history[d];
      post.lastError = null;
      acc.error = null;
      return true;
    } catch (e) {
      post.lastError = e.code === 190 || e.status === 401 ? "계정 연결이 만료되었습니다. 다시 연결하세요" : e.message;
      if (e.code === 190 || e.status === 401) acc.error = "expired";
      return false;
    }
  }
  let running = false;
  async function runAll(filter = () => true) {
    if (running) return { busy: true };
    running = true;
    try {
      const db = load();
      let ok = 0, fail = 0;
      for (const p of db.posts.filter(filter)) (await refreshPost(db, p)) ? ok++ : fail++;
      save(db);
      return { ok, fail };
    } finally { running = false; }
  }

  // ---- 토큰 갱신(장기 토큰은 약 60일 만료) ----
  // 갱신하면 만료가 다시 60일로 늘어나고 응답의 expires_in 으로 실제 만료일을 알 수 있다. (발급 후 24시간이 지나야 갱신 가능)
  // 일주일마다 갱신해 항상 만료일이 한참 남아 있게 한다.
  const REFRESH_EVERY_MS = 7 * 86400e3;
  async function refreshAccount(a) {
    try {
      const d = await graph("GET", `${GRAPH}/refresh_access_token`, { grant_type: "th_refresh_token", access_token: a.token });
      a.token = d.access_token || a.token;
      a.expiresAt = new Date(Date.now() + (d.expires_in || 5184000) * 1000).toISOString();
      a.lastRefreshAt = new Date().toISOString();
      a.error = null;
      a.refreshError = null;
      return { ok: true };
    } catch (e) {
      a.refreshError = e.message;
      if (e.code === 190 || e.status === 401) a.error = "expired"; // 이미 만료됨 → 다시 연결 필요
      return { ok: false, message: e.message };
    }
  }
  async function refreshTokens() {
    const db = load();
    let changed = false;
    for (const a of db.accounts) {
      const last = new Date(a.lastRefreshAt || a.createdAt || 0).getTime();
      const nearExpiry = a.expiresAt && new Date(a.expiresAt).getTime() - Date.now() < 10 * 86400e3;
      if (Date.now() - last < REFRESH_EVERY_MS && !nearExpiry) continue;
      await refreshAccount(a);
      changed = true;
    }
    if (changed) save(db);
  }

  // ---- API ----
  const publicAccount = (a) => ({ id: a.id, projectId: a.projectId, username: a.username, expiresAt: a.expiresAt, lastRefreshAt: a.lastRefreshAt || null, refreshError: a.refreshError || null, error: a.error || null });
  app.get("/api/threads/config", requireAdmin, (req, res) => res.json({ configured: configured(), redirectUri: redirectUri(req), scopes: SCOPES.split(",") }));

  app.get("/api/threads", (req, res) => {
    const pid = String(req.query.projectId || "");
    const db = load();
    res.json({
      configured: configured(),
      accounts: db.accounts.filter((a) => !pid || a.projectId === pid).map(publicAccount),
      posts: db.posts.filter((p) => !pid || p.projectId === pid).map(({ id, projectId, url, text, postedAt, history, lastError, source, extAt }) => ({ id, projectId, url, text, postedAt, source: source || "api", extAt: extAt || null, history: history || {}, lastError: lastError || null })),
      running,
      lastAutoDate: db.meta.lastAutoDate || null,
    });
  });

  app.get("/api/threads/connect", requireAdmin, needConfig, (req, res) => {
    const projectId = String(req.query.projectId || "");
    if (!projectId) return res.status(400).json({ error: "invalid_input" });
    const body = b64({ p: projectId, n: crypto.randomBytes(8).toString("hex"), e: Date.now() + 15 * 60 * 1000 });
    const q = new URLSearchParams({ client_id: APP_ID, redirect_uri: redirectUri(req), scope: SCOPES, response_type: "code", state: `${body}.${sign(body)}` });
    res.redirect(`${AUTH_BASE}/oauth/authorize?${q}`);
  });

  app.get("/api/threads/callback", requireAdmin, needConfig, async (req, res) => {
    const back = (msg) => res.redirect(`/threads.html?${msg}`);
    try {
      if (req.query.error) return back("error=" + encodeURIComponent(req.query.error_description || req.query.error));
      const [body, sig] = String(req.query.state || "").split(".");
      if (!body || !sig || sig.length !== sign(body).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) return back("error=" + encodeURIComponent("잘못된 요청입니다(state). 다시 연결해 주세요."));
      const st = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
      if (st.e < Date.now()) return back("error=" + encodeURIComponent("연결 시간이 지났습니다. 다시 연결해 주세요."));
      const code = String(req.query.code || "").replace(/#_$/, "");
      const short = await graph("POST", `${GRAPH}/oauth/access_token`, { client_id: APP_ID, client_secret: APP_SECRET, code, grant_type: "authorization_code", redirect_uri: redirectUri(req) });
      const long = await graph("GET", `${GRAPH}/access_token`, { grant_type: "th_exchange_token", client_secret: APP_SECRET, access_token: short.access_token });
      const me = await graph("GET", `${GRAPH}/v1.0/me`, { fields: "id,username", access_token: long.access_token });
      const db = load();
      const existing = db.accounts.find((a) => a.userId === String(me.id) && a.projectId === st.p);
      const acc = existing || { id: crypto.randomUUID(), projectId: st.p, userId: String(me.id), createdAt: new Date().toISOString() };
      Object.assign(acc, { username: me.username, token: long.access_token, expiresAt: new Date(Date.now() + (long.expires_in || 5184000) * 1000).toISOString(), error: null });
      if (!existing) db.accounts.push(acc);
      save(db);
      back("connected=" + encodeURIComponent(me.username || ""));
    } catch (e) {
      back("error=" + encodeURIComponent(`Threads 연결 실패: ${e.message}`));
    }
  });

  // 토큰으로 연결: Meta 앱의 "사용자 토큰 생성기"에서 받은 장기 액세스 토큰을 붙여넣는다(OAuth 콜백 주소 설정이 필요 없다).
  app.post("/api/threads/accounts/token", requireAdmin, async (req, res) => {
    const projectId = String((req.body || {}).projectId || "");
    const token = String((req.body || {}).token || "").trim();
    if (!projectId || token.length < 20) return res.status(400).json({ error: "invalid_input", message: "프로젝트와 액세스 토큰을 입력하세요." });
    try {
      const me = await graph("GET", `${GRAPH}/v1.0/me`, { fields: "id,username", access_token: token });
      const db = load();
      const existing = db.accounts.find((a) => a.userId === String(me.id) && a.projectId === projectId);
      const acc = existing || { id: crypto.randomUUID(), projectId, userId: String(me.id), createdAt: new Date().toISOString() };
      // 생성기 토큰은 장기 토큰(약 60일). 만료 10일 전부터 서버가 자동 갱신한다.
      Object.assign(acc, { username: me.username, token, expiresAt: new Date(Date.now() + 60 * 86400e3).toISOString(), error: null, via: "token" });
      if (!existing) db.accounts.push(acc);
      save(db);
      res.status(201).json({ username: me.username });
    } catch (e) {
      res.status(400).json({ error: "bad_token", message: `토큰을 확인하지 못했습니다: ${e.message}` });
    }
  });

  // 지금 갱신: 토큰 갱신이 동작하는지 바로 확인(발급 후 24시간이 지나야 성공)
  app.post("/api/threads/accounts/:id/refresh", requireAdmin, async (req, res) => {
    const db = load();
    const a = db.accounts.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "not_found" });
    const r = await refreshAccount(a);
    save(db);
    if (!r.ok) return res.status(400).json({ error: "refresh_failed", message: `갱신하지 못했습니다: ${r.message}` });
    res.json({ ok: true, expiresAt: a.expiresAt });
  });

  app.delete("/api/threads/accounts/:id", requireAdmin, (req, res) => {
    const db = load();
    db.accounts = db.accounts.filter((a) => a.id !== req.params.id);
    db.posts = db.posts.filter((p) => p.accountId !== req.params.id);
    save(db);
    res.json({ ok: true });
  });

  app.post("/api/threads/posts", requireAdmin, async (req, res) => {
    const { projectId } = req.body || {};
    const url = await resolveShare((req.body || {}).url);
    const code = shortcodeOf(url);
    if (!projectId || !code) return res.status(400).json({ error: "invalid_url", message: "Threads 게시글 주소(…/post/코드 또는 공유 링크)를 입력하세요. 공유 링크를 열지 못했다면 브라우저 주소창에 나타난 주소를 붙여넣어 보세요." });
    const db = load();
    if (db.posts.some((p) => p.projectId === projectId && p.shortcode === code)) return res.status(409).json({ error: "exists", message: "이미 등록된 게시글입니다." });
    let found = null, account = null;
    for (const a of db.accounts.filter((x) => x.projectId === projectId && !x.error)) {
      try { found = await findMedia(a, code); } catch { /* 이 계정에서 못 찾으면 공개 링크로 등록 */ }
      if (found) { account = a; break; }
    }
    const base = { id: crypto.randomUUID(), projectId, shortcode: code, history: {}, createdAt: new Date().toISOString() };
    let post;
    if (found) post = { ...base, accountId: account.id, url: found.permalink || String(url), mediaId: found.id, text: String(found.text || "").slice(0, 200), postedAt: found.timestamp || null };
    else {
      let u;
      try { u = new URL(String(url)); } catch { /* 아래에서 처리 */ }
      if (!u || !WEB_HOSTS.includes(u.hostname)) return res.status(400).json({ error: "invalid_url", message: "threads.com 게시글 주소를 입력하세요." });
      post = { ...base, source: "public", url: u.origin + u.pathname, text: "", postedAt: null };
    }
    db.posts.push(post);
    await refreshPost(db, post);
    save(db);
    res.status(201).json({ id: post.id, source: post.source || "api", lastError: post.lastError });
  });

  // 숫자 직접 입력(공개 링크로 등록한 글): 자동으로 못 읽을 때 오늘 조회수를 손으로 기록한다.
  app.post("/api/threads/posts/:id/manual", requireAdmin, (req, res) => {
    const db = load();
    const p = db.posts.find((x) => x.id === req.params.id);
    const views = Number((req.body || {}).views);
    if (!p || p.source !== "public") return res.status(404).json({ error: "not_found" });
    if (!Number.isInteger(views) || views < 0) return res.status(400).json({ error: "invalid_input", message: "조회수는 0 이상의 정수로 입력하세요." });
    (p.history ??= {})[today()] = { views };
    p.lastError = null;
    save(db);
    res.json({ ok: true });
  });

  app.delete("/api/threads/posts/:id", requireAdmin, (req, res) => {
    const db = load();
    db.posts = db.posts.filter((p) => p.id !== req.params.id);
    save(db);
    res.json({ ok: true });
  });

  // ---- Chrome 확장 프로그램 연동: 담당자 PC 의 로그인된 Chrome 이 글을 열어 좋아요·댓글까지 읽어 보낸다 ----
  // 확장 프로그램은 로그인 쿠키 대신 전용 키(X-Ext-Key)로 인증한다. 키는 관리자가 화면에서 확인·재발급한다.
  const extKey = (db) => (db.meta.extKey ||= crypto.randomBytes(24).toString("hex"));
  const extAuth = (req, res, next) => {
    const db = load();
    const given = Buffer.from(String(req.get("x-ext-key") || ""));
    const want = Buffer.from(extKey(db));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: "bad_key", message: "확장 프로그램 키가 올바르지 않습니다." });
    next();
  };
  app.get("/api/threads/ext-key", requireAdmin, (req, res) => { const db = load(); const k = extKey(db); save(db); res.json({ key: k }); });
  app.post("/api/threads/ext-key", requireAdmin, (req, res) => { const db = load(); db.meta.extKey = crypto.randomBytes(24).toString("hex"); save(db); res.json({ key: db.meta.extKey }); });
  app.get("/api/threads/ext/tasks", extAuth, (req, res) => {
    const db = load();
    res.json({ date: today(), posts: db.posts.filter((p) => p.source === "public").map((p) => ({ id: p.id, url: p.url })) });
  });
  app.post("/api/threads/ext/report", extAuth, (req, res) => {
    const db = load();
    const p = db.posts.find((x) => x.id === String((req.body || {}).postId || "") && x.source === "public");
    if (!p) return res.status(404).json({ error: "not_found" });
    const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    const got = {};
    for (const k of ["views", "likes", "replies", "reposts", "shares"]) { const v = num((req.body || {})[k]); if (v != null) got[k] = v; }
    if (!Object.keys(got).length) return res.status(400).json({ error: "invalid_input", message: "기록할 숫자가 없습니다." });
    const h = (p.history ??= {});
    h[today()] = { ...(h[today()] || {}), ...got };
    const t = String((req.body || {}).text || "").trim().slice(0, 200);
    if (t && (!p.text || /^[\w.]+$/.test(p.text))) p.text = t; // 본문이 아직 없는 글만 채운다(이미 있는 제목은 유지)
    p.lastError = null;
    p.extAt = new Date().toISOString();
    save(db);
    res.json({ ok: true, saved: got });
  });
  // 확장 프로그램 설치 파일(zip) 내려받기: extension/ 폴더를 묶어 보낸다
  app.get("/api/threads/extension.zip", requireAdmin, async (req, res) => {
    const JSZip = require("jszip");
    const dir = path.join(__dirname, "extension");
    const zip = new JSZip();
    for (const f of fs.readdirSync(dir)) zip.file(`threads-extension/${f}`, fs.readFileSync(path.join(dir, f)));
    res.set({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="threads-extension.zip"' });
    res.send(await zip.generateAsync({ type: "nodebuffer" }));
  });

  // 진단(관리자): 서버가 공개 페이지로 실제로 받는 내용을 요약해 보여준다(조회수를 못 읽을 때 원인 확인용)
  app.get("/api/threads/debug", requireAdmin, async (req, res) => {
    try {
      // n=2 처럼 번호를 주면 등록된 공개 글의 n번째 주소를 쓴다(주소를 복사하지 않아도 진단 가능)
      const pub = load().posts.filter((p) => p.source === "public");
      const u = new URL(req.query.n ? (pub[Number(req.query.n) - 1] || {}).url : String(req.query.url || ""));
      if (!WEB_HOSTS.includes(u.hostname)) return res.status(400).json({ error: "invalid_url" });
      if (req.query.browser) {
        const b = await browserText(u.href);
        return res.json({ mode: "browser", title: b.title, parsedViews: parseViews(b.text), counts: b.counts, iconLabels: b.seen, actionBar: b.bar, length: b.text.length, text: b.text.slice(0, 1500) });
      }
      const r = await fetch(u, { headers: { "User-Agent": WEB_UA, "Accept-Language": "ko-KR,ko;q=0.9", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const around = (re) => [...html.matchAll(re)].slice(0, 8).map((m) => html.slice(Math.max(0, m.index - 80), m.index + 120).replace(/\s+/g, " "));
      res.json({ status: r.status, finalUrl: r.url, length: html.length, title: (/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || "", ogTitle: metaOf(html, "og:title"), ogDescription: metaOf(html, "og:description").slice(0, 200), parsedViews: parseViews(html), viewMentions: around(/조회|views?\b|view_count|impression/gi), loginWall: /login|log in|로그인/i.test(html.slice(0, 20000)), head: html.slice(0, 300) });
    } catch (e) { res.status(400).json({ error: "fetch_failed", message: e.message }); }
  });

  app.post("/api/threads/run", requireAdmin, async (req, res) => {
    const { projectId, postId, postIds } = req.body || {};
    const ids = Array.isArray(postIds) ? new Set(postIds.map(String)) : null; // 체크한 글만 조회
    const r = await runAll((p) => (ids ? ids.has(p.id) : postId ? p.id === postId : !projectId || p.projectId === projectId));
    if (r.busy) return res.status(409).json({ error: "busy" });
    res.json(r);
  });

  // 매일 KST AUTO_HOUR 시 이후 첫 확인 시점에 전체 게시글 기록 + 토큰 갱신 (순위 체크와 같은 스케줄)
  if (process.env.RANK_AUTO !== "off") {
    setInterval(async () => {
      try {
        const kst = new Date(Date.now() + 9 * 3600e3);
        if (running || kst.getUTCHours() < AUTO_HOUR) return;
        const db = load();
        if (db.meta.lastAutoDate === today() || !db.posts.length) return;
        db.meta.lastAutoDate = today();
        save(db);
        await refreshTokens();
        await runAll();
      } catch (e) { console.error("[threads] auto run failed:", e.message); }
    }, Number(process.env.THREADS_AUTO_INTERVAL_MS || 10 * 60 * 1000)).unref(); // 테스트에서만 짧게 바꾼다
  }

  return { exportData: () => load(), importData: (d) => save(d), file };
}

module.exports = { mount, parseViews, bodyOf };
