// 로그인/권한. 계정은 두 종류:
//  - 관리자: 환경 변수 APP_USER(기본 admin) / APP_PASSWORD 로 정의. 모든 프로젝트와 계정 관리 가능.
//  - 회원(viewer): 관리자가 만든 계정. 지정된 프로젝트의 순위표만 볼 수 있고 아무것도 수정할 수 없다.
// 회원 계정은 DATA_DIR/users.json 에 비밀번호 해시(scrypt)로 저장된다.
// APP_PASSWORD 도 없고 회원 계정도 없으면 로그인 없이 열린 상태(로컬 개발용)로 동작한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COOKIE = "kw_session";
const SESSION_MS = 7 * 24 * 3600 * 1000;
const ENV_USER = process.env.APP_USER || "admin";
const ENV_PASS = process.env.APP_PASSWORD || "";
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function mount(app, { dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const usersFile = path.join(dataDir, "users.json");
  const secretFile = path.join(dataDir, "auth-secret");

  // ---- 저장소 ----
  const loadUsers = () => (fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, "utf-8")).users || [] : []);
  const saveUsers = (users) => fs.writeFileSync(usersFile, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  const secret = (() => {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, "utf-8");
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(secretFile, s, { mode: 0o600 });
    return s;
  })();

  const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
  const checkPw = (pw, u) => {
    const a = Buffer.from(hashPw(pw, u.salt), "hex"), b = Buffer.from(u.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // ---- 세션 토큰 (서명된 쿠키) ----
  const sign = (s) => crypto.createHmac("sha256", secret).update(s).digest("base64url");
  const envPv = () => sha(ENV_PASS).toString("hex").slice(0, 8); // 환경 변수 비밀번호가 바뀌면 기존 세션 무효
  function makeToken(username, pv) {
    const exp = Date.now() + SESSION_MS;
    const body = `${Buffer.from(username).toString("base64url")}.${exp}.${pv}`;
    return `${body}.${sign(body)}`;
  }
  function userFromToken(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 4) return null;
    const body = parts.slice(0, 3).join(".");
    const good = sign(body);
    if (parts[3].length !== good.length || !crypto.timingSafeEqual(Buffer.from(parts[3]), Buffer.from(good))) return null;
    const username = Buffer.from(parts[0], "base64url").toString("utf-8");
    if (Number(parts[1]) < Date.now()) return null;
    return resolveUser(username, parts[2]);
  }
  function resolveUser(username, pv) {
    if (ENV_PASS && username === ENV_USER) return pv === envPv() ? { username, role: "admin", name: "관리자", projectIds: null } : null;
    const u = loadUsers().find((x) => x.username === username);
    if (!u || String(u.pv) !== pv) return null;
    return { username, role: "viewer", name: u.name || username, projectIds: u.projectIds || [], id: u.id };
  }
  const readCookie = (req, name) => {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(req.headers.cookie || "");
    return m ? decodeURIComponent(m[1]) : null;
  };
  function authenticate(req) {
    const t = readCookie(req, COOKIE);
    if (t) { const u = userFromToken(t); if (u) return u; }
    const m = /^Basic (.+)$/.exec(req.headers.authorization || ""); // 스크립트용: 관리자 계정만
    if (m && ENV_PASS) {
      const dec = Buffer.from(m[1], "base64").toString("utf-8");
      const i = dec.indexOf(":");
      if (i >= 0 && safeEq(dec.slice(0, i), ENV_USER) && safeEq(dec.slice(i + 1), ENV_PASS)) return { username: ENV_USER, role: "admin", name: "관리자", projectIds: null };
    }
    return null;
  }
  const authEnabled = () => !!ENV_PASS || loadUsers().length > 0;

  // ---- 로그인 시도 제한 (IP당 10분에 10회 실패 시 잠금) ----
  const fails = new Map();
  const locked = (ip) => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60 * 1000; };
  const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 10 * 60 * 1000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

  function setSession(req, res, username, pv) {
    res.cookie(COOKIE, makeToken(username, pv), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_MS, path: "/" });
  }

  // ---- 회원(viewer)이 쓸 수 있는 것: 읽기 전용 순위 데이터뿐 ----
  const VIEWER_API = [["GET", "/api/me"], ["GET", "/api/projects"], ["GET", "/api/rank"], ["GET", "/api/rank/xlsx"], ["POST", "/api/logout"]];
  const VIEWER_PAGES = new Set(["/rank.html", "/rank", "/login.html"]);
  function viewerGuard(req, res, next) {
    if (!req.path.startsWith("/api/")) {
      if (req.method === "GET" && VIEWER_PAGES.has(req.path)) return next();
      return res.redirect("/rank.html");
    }
    if (!VIEWER_API.some(([m, p]) => m === req.method && p === req.path)) return res.status(403).json({ error: "forbidden" });
    if (req.method === "GET" && (req.path === "/api/rank" || req.path === "/api/rank/xlsx")) { // 허용된 프로젝트만
      const allowed = req.user.projectIds || [];
      const pid = req.query.projectId;
      if (!pid) { if (allowed.length === 1) req.query.projectId = allowed[0]; else return res.status(403).json({ error: "forbidden" }); }
      else if (!allowed.includes(String(pid))) return res.status(403).json({ error: "forbidden" });
    }
    next();
  }

  app.set("trust proxy", 1); // Railway 등 프록시 뒤: 실제 IP, https 여부 인식

  app.use((req, res, next) => {
    if (req.path === "/healthz" || req.path === "/login.html" || (req.method === "POST" && req.path === "/api/login")) return next();
    if (!authEnabled()) { req.user = { username: "(로컬)", role: "admin", name: "로컬 관리자", projectIds: null, open: true }; return next(); }
    const u = authenticate(req);
    if (!u) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login_required" });
      return res.redirect("/login.html" + (req.method === "GET" && req.path !== "/" ? "?next=" + encodeURIComponent(req.originalUrl) : ""));
    }
    req.user = u;
    if (u.role === "viewer") return viewerGuard(req, res, next);
    next();
  });
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));
  const requireManaged = (req, res, next) => (req.user.open ? res.status(400).json({ error: "auth_not_enabled", message: "먼저 서버 환경 변수 APP_PASSWORD 를 설정해 관리자 로그인을 켜세요." }) : next());

  // ---- 로그인/로그아웃/내 정보 ----
  app.post("/api/login", (req, res) => {
    const ip = req.ip;
    if (locked(ip)) return res.status(429).json({ error: "too_many", message: "로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요." });
    const { username = "", password = "" } = req.body || {};
    const name = String(username).trim();
    let ok = false, pv = "";
    if (ENV_PASS && name === ENV_USER) { ok = safeEq(password, ENV_PASS); pv = envPv(); }
    else {
      const u = loadUsers().find((x) => x.username === name);
      // 없는 계정도 같은 시간이 걸리도록 더미 해시를 계산
      if (u) { ok = checkPw(password, u); pv = String(u.pv); } else hashPw(password, "0000000000000000");
    }
    if (!ok) { noteFail(ip); return res.status(401).json({ error: "bad_credentials", message: "아이디 또는 비밀번호가 올바르지 않습니다." }); }
    fails.delete(ip);
    setSession(req, res, name, pv);
    res.json({ ok: true, role: name === ENV_USER && ENV_PASS ? "admin" : "viewer" });
  });
  app.post("/api/logout", (req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });
  app.get("/api/me", (req, res) => res.json({ username: req.user.username, name: req.user.name, role: req.user.role, projectIds: req.user.projectIds, openMode: !!req.user.open }));

  // ---- 계정 관리 (관리자 전용) ----
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name || "", projectIds: u.projectIds || [], createdAt: u.createdAt });
  app.get("/api/users", requireAdmin, (req, res) => res.json({ openMode: !!req.user.open, admin: ENV_PASS ? ENV_USER : null, users: loadUsers().map(publicUser) }));
  app.post("/api/users", requireAdmin, requireManaged, (req, res) => {
    const { username, password, name = "", projectIds = [] } = req.body || {};
    if (!USERNAME_RE.test(String(username || ""))) return res.status(400).json({ error: "invalid_username", message: "아이디는 영문·숫자·._- 3~32자로 입력하세요." });
    if (String(password || "").length < 8) return res.status(400).json({ error: "weak_password", message: "비밀번호는 8자 이상이어야 합니다." });
    const users = loadUsers();
    if (username === ENV_USER || users.some((u) => u.username === username)) return res.status(409).json({ error: "exists", message: "이미 있는 아이디입니다." });
    const salt = crypto.randomBytes(16).toString("hex");
    const u = { id: crypto.randomUUID(), username, name: String(name).slice(0, 60), projectIds: [...new Set((projectIds || []).map(String))], salt, hash: hashPw(password, salt), pv: 1, createdAt: new Date().toISOString() };
    users.push(u);
    saveUsers(users);
    res.status(201).json(publicUser(u));
  });
  app.patch("/api/users/:id", requireAdmin, requireManaged, (req, res) => {
    const users = loadUsers();
    const u = users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: "not_found" });
    const { password, name, projectIds } = req.body || {};
    if (Array.isArray(projectIds)) u.projectIds = [...new Set(projectIds.map(String))];
    if (typeof name === "string") u.name = name.slice(0, 60);
    if (password !== undefined) {
      if (String(password).length < 8) return res.status(400).json({ error: "weak_password", message: "비밀번호는 8자 이상이어야 합니다." });
      u.salt = crypto.randomBytes(16).toString("hex");
      u.hash = hashPw(password, u.salt);
      u.pv = Number(u.pv || 1) + 1; // 기존 로그인 세션 무효화
    }
    saveUsers(users);
    res.json(publicUser(u));
  });
  app.delete("/api/users/:id", requireAdmin, requireManaged, (req, res) => {
    saveUsers(loadUsers().filter((x) => x.id !== req.params.id));
    res.json({ ok: true });
  });

  return {
    usersFile,
    exportUsers: () => loadUsers(),
    importUsers: (list) => saveUsers(list),
    // 프로젝트가 삭제되면 회원 계정의 연결도 제거
    removeProject(id) { const users = loadUsers(); let ch = false; for (const u of users) if ((u.projectIds || []).includes(id)) { u.projectIds = u.projectIds.filter((p) => p !== id); ch = true; } if (ch) saveUsers(users); },
    filterProjects(req, list) { return req.user && req.user.role === "viewer" ? list.filter((p) => (req.user.projectIds || []).includes(p.id)) : list; },
  };
}

module.exports = { mount };
