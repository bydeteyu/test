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

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

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

  // ---- 토큰 갱신(약 60일 만료): 만료 10일 전부터 매일 갱신 시도 ----
  async function refreshTokens() {
    const db = load();
    let changed = false;
    for (const a of db.accounts) {
      if (a.expiresAt && new Date(a.expiresAt).getTime() - Date.now() > 10 * 86400e3) continue;
      try {
        const d = await graph("GET", `${GRAPH}/refresh_access_token`, { grant_type: "th_refresh_token", access_token: a.token });
        a.token = d.access_token; a.expiresAt = new Date(Date.now() + (d.expires_in || 5184000) * 1000).toISOString(); a.error = null; changed = true;
      } catch (e) { a.error = "refresh_failed"; changed = true; }
    }
    if (changed) save(db);
  }

  // ---- API ----
  const publicAccount = (a) => ({ id: a.id, projectId: a.projectId, username: a.username, expiresAt: a.expiresAt, error: a.error || null });
  app.get("/api/threads/config", requireAdmin, (req, res) => res.json({ configured: configured(), redirectUri: redirectUri(req), scopes: SCOPES.split(",") }));

  app.get("/api/threads", (req, res) => {
    const pid = String(req.query.projectId || "");
    const db = load();
    res.json({
      configured: configured(),
      accounts: db.accounts.filter((a) => !pid || a.projectId === pid).map(publicAccount),
      posts: db.posts.filter((p) => !pid || p.projectId === pid).map(({ id, projectId, url, text, postedAt, history, lastError }) => ({ id, projectId, url, text, postedAt, history: history || {}, lastError: lastError || null })),
      running,
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

  app.delete("/api/threads/accounts/:id", requireAdmin, (req, res) => {
    const db = load();
    db.accounts = db.accounts.filter((a) => a.id !== req.params.id);
    db.posts = db.posts.filter((p) => p.accountId !== req.params.id);
    save(db);
    res.json({ ok: true });
  });

  app.post("/api/threads/posts", requireAdmin, needConfig, async (req, res) => {
    const { projectId, url } = req.body || {};
    const code = shortcodeOf(url);
    if (!projectId || !code) return res.status(400).json({ error: "invalid_url", message: "Threads 게시글 주소(…/post/코드)를 입력하세요." });
    const db = load();
    const accounts = db.accounts.filter((a) => a.projectId === projectId);
    if (!accounts.length) return res.status(400).json({ error: "no_account", message: "이 프로젝트에 연결된 Threads 계정이 없습니다. 먼저 계정을 연결하세요." });
    if (db.posts.some((p) => p.projectId === projectId && p.shortcode === code)) return res.status(409).json({ error: "exists", message: "이미 등록된 게시글입니다." });
    let found = null, account = null, lastErr = null;
    for (const a of accounts) {
      try { found = await findMedia(a, code); } catch (e) { lastErr = e; }
      if (found) { account = a; break; }
    }
    if (!found) return res.status(404).json({ error: "not_found", message: lastErr ? `게시글을 확인하지 못했습니다: ${lastErr.message}` : "연결된 계정의 게시글 중에서 이 주소의 글을 찾지 못했습니다. (연결한 계정이 올린 글만 조회할 수 있습니다)" });
    const post = { id: crypto.randomUUID(), projectId, accountId: account.id, url: found.permalink || String(url), shortcode: code, mediaId: found.id, text: String(found.text || "").slice(0, 200), postedAt: found.timestamp || null, history: {}, createdAt: new Date().toISOString() };
    db.posts.push(post);
    await refreshPost(db, post);
    save(db);
    res.status(201).json({ id: post.id, lastError: post.lastError });
  });

  app.delete("/api/threads/posts/:id", requireAdmin, (req, res) => {
    const db = load();
    db.posts = db.posts.filter((p) => p.id !== req.params.id);
    save(db);
    res.json({ ok: true });
  });

  app.post("/api/threads/run", requireAdmin, needConfig, async (req, res) => {
    const { projectId, postId } = req.body || {};
    const r = await runAll((p) => (postId ? p.id === postId : !projectId || p.projectId === projectId));
    if (r.busy) return res.status(409).json({ error: "busy" });
    res.json(r);
  });

  // 매일 KST AUTO_HOUR 시 이후 첫 확인 시점에 전체 게시글 기록 + 토큰 갱신 (순위 체크와 같은 스케줄)
  if (process.env.RANK_AUTO !== "off") {
    setInterval(async () => {
      try {
        const kst = new Date(Date.now() + 9 * 3600e3);
        if (running || kst.getUTCHours() < AUTO_HOUR || !configured()) return;
        const db = load();
        if (db.meta.lastAutoDate === today() || !db.posts.length) return;
        db.meta.lastAutoDate = today();
        save(db);
        await refreshTokens();
        await runAll();
      } catch (e) { console.error("[threads] auto run failed:", e.message); }
    }, 10 * 60 * 1000).unref();
  }

  return { exportData: () => load(), importData: (d) => save(d), file };
}

module.exports = { mount };
