// 카페 댓글 체크: 등록한 카페 글에 특정 작성자의 댓글이 유지되고 있는지 매일 확인한다.
// 1단계(현재): 서버가 그 글의 댓글을 읽을 수 있는지 확인하는 진단 엔드포인트.
//   - 네이버가 막혀 있는 개발 샌드박스에서는 실제 조회가 안 되므로, 배포(Railway)에서 실제 글로 검증한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalize, resolveShortUrl, resolveClubId, UA, fetchKeyword, findTarget, ensureMatchKey, today } = require("./rank-tracker/core");

const AUTO_HOUR = Number(process.env.CAFE_COMMENT_HOUR || 11); // KST, 기본 오전 11시

const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

// 사용자가 넣은 주소(단축/모바일/검색 유입 포함)에서 카페키(cafe.naver.com/이름|번호/글번호)와 art 토큰을 뽑는다.
async function toCafeRef(raw) {
  let url = String(raw || "").trim();
  if (!url) return null;
  if (/(^|\/\/)naver\.me\//.test(url)) { const f = await resolveShortUrl(url); if (f) url = f; }
  const ref = normalize(/^https?:\/\//.test(url) ? url : "https://" + url);
  if (!ref || ref.type !== "cafe" || !/^cafe\.naver\.com\/[^/]+\/\d+$/.test(ref.key || "")) return null;
  const m = /^cafe\.naver\.com\/([^/]+)\/(\d+)$/.exec(ref.key);
  return { key: ref.key, club: m[1], art: m[2], artToken: ref.art || null };
}

// JSON 어디에 있든 댓글 항목을 긁어 작성자 닉네임 목록을 만든다(네이버 응답 구조 변화에 견디게).
function collectComments(j) {
  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    const w = node.writer || node.memberInfo || null;
    const nick = (w && (w.nick || w.nickname || w.memberNickname || w.nickName)) || node.writerNickname || node.nickName;
    const hasContent = typeof node.content === "string" || typeof node.comment === "string";
    if (nick && hasContent) {
      const content = String(node.content || node.comment || "");
      const k = nick + "\u0000" + content;
      if (!seen.has(k)) { seen.add(k); out.push({ nick: String(nick), content: content.slice(0, 120), deleted: !!(node.deleted || node.isDeleted) }); }
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
  })(j);
  return out;
}

// 한 카페 글의 댓글을 읽어온다. { ok, comments:[{nick,content,deleted}], reason, trace }
async function fetchComments(raw, { maxPages = 5 } = {}) {
  const ref = await toCafeRef(raw);
  if (!ref) return { ok: false, comments: [], reason: "카페 글 주소를 인식하지 못했습니다(cafe.naver.com/…/글번호 형태).", trace: { raw: String(raw).slice(0, 120) } };
  const headers = { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9", Referer: "https://cafe.naver.com/" };
  const trace = { key: ref.key, hasArt: !!ref.artToken };
  const clubId = /^\d+$/.test(ref.club) ? ref.club : await resolveClubId(ref.club, headers);
  trace.clubId = clubId || null;
  if (!clubId) return { ok: false, comments: [], reason: "카페 번호를 찾지 못했습니다.", trace };
  const artQ = ref.artToken ? `&art=${encodeURIComponent(ref.artToken)}` : "";
  const all = [];
  let lastStatus = null, totalCount = null, forbidden = false;
  trace.tried = [];
  const totalOf = (j) => { const cm = j && j.result && j.result.comments; return (cm && cm.pageInfo && (cm.pageInfo.totalCount ?? cm.pageInfo.count)) ?? (cm && (cm.totalCount ?? cm.commentCount)) ?? null; };

  // 1) 글 API(조회수를 읽는 바로 그 호출, useCafeId=true 로 200). 임베드된 댓글 + 총 댓글수를 얻는다.
  try {
    const aurl = `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${clubId}/articles/${ref.art}?query=&useCafeId=true&requestFrom=A${artQ}`;
    const res = await fetch(aurl, { headers });
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) forbidden = true;
    else if (res.ok) {
      const j = await res.json();
      totalCount = totalOf(j);
      const items = collectComments(j);
      all.push(...items);
      trace.tried.push({ tag: "article", status: res.status, found: items.length, totalCount });
    } else trace.tried.push({ tag: "article", status: res.status });
  } catch (e) { trace.tried.push({ tag: "article", error: e.message }); }

  // 2) 댓글이 더 있으면 전용 댓글 API로 페이지를 끝까지 넘겨 모두 모은다(최신 댓글 누락 방지).
  if (!forbidden && (totalCount == null || all.length < totalCount)) {
    const pageUrl = (p) => `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${clubId}/articles/${ref.art}/comments/pages/${p}?requestFrom=A&orderBy=asc&useCafeId=true&pageSize=100${artQ}`;
    for (let p = 1; p <= 30; p++) {
      let res;
      try { res = await fetch(pageUrl(p), { headers }); } catch (e) { trace.tried.push({ tag: "comments", page: p, error: e.message }); break; }
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) { if (!all.length) forbidden = true; break; }
      if (!res.ok) { trace.tried.push({ tag: "comments", page: p, status: res.status }); break; }
      const j = await res.json();
      const items = collectComments(j);
      if (p === 1) trace.tried.push({ tag: "comments", page: 1, status: res.status, found: items.length, totalCount: totalOf(j) });
      if (!items.length) break;
      all.push(...items);
      const tc = totalOf(j) ?? totalCount;
      const seenN = new Set(all.map((c) => c.nick + "\u0000" + c.content)).size;
      if ((tc != null && seenN >= tc) || items.length < 100) break; // 총수 채웠거나 마지막 페이지
    }
  }
  trace.status = lastStatus;
  trace.collected = all.length;
  trace.totalCount = totalCount;
  if (forbidden) return { ok: false, comments: [], reason: "가입(로그인) 필요 또는 비공개 카페 — 서버가 댓글을 읽을 수 없습니다.", trace };
  // 중복 제거
  const uniq = [];
  const seen = new Set();
  for (const c of all) { const k = c.nick + "\u0000" + c.content; if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
  if (!uniq.length) return { ok: false, comments: [], reason: lastStatus && lastStatus >= 400 ? `댓글 조회 실패(HTTP ${lastStatus})` : "댓글을 찾지 못했습니다(댓글이 없거나, 서버가 읽을 수 없는 카페).", trace };
  return { ok: true, comments: uniq, reason: null, trace };
}

// 작성자 닉네임이 댓글 목록에 있는지 (삭제되지 않은 것 기준)
function authorPresent(comments, author) {
  const a = squash(author);
  return comments.some((c) => !c.deleted && squash(c.nick) === a);
}

// 한 항목 점검: 카페 검색 순위(1~30 / 범위 밖) + 지정 작성자 댓글 유지 여부
async function checkItem(it) {
  let rank = null, present = null, error = null;
  try {
    it.match = it.url; // findTarget 이 쓰는 주소 필드
    await ensureMatchKey(it); // naver.me 단축 주소는 카페 글 키로 풀어둔다
    const fetched = await fetchKeyword(it.keyword, { maxRank: 30, delayMs: 1500 });
    const posts = fetched.cafe;
    if (posts === null) error = "카페 검색 조회 실패";
    else if (posts.length) {
      const hit = findTarget(posts.slice(0, 30), it, {});
      rank = hit ? (hit.rank ?? null) : null; // null = 30위 밖
      if (hit && hit.key) { it.postKey = hit.key; if (hit.art) it.postArt = hit.art; }
    } else rank = null;
  } catch (e) { error = "순위 조회 오류: " + e.message; }
  try {
    const r = await fetchComments(it.url);
    if (r.ok) present = authorPresent(r.comments, it.author);
    else error = (error ? error + " / " : "") + "댓글: " + r.reason;
  } catch (e) { error = (error ? error + " / " : "") + "댓글 조회 오류: " + e.message; }
  const day = today();
  (it.history ??= {})[day] = { rank, present };
  it.lastCheckedAt = new Date().toISOString();
  it.lastError = error;
  return { rank, present, error };
}

function mount(app, { dataDir } = {}) {
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));
  const file = path.join(dataDir || ".", "cafe-comments.json");
  function load() {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 새로 시작 */ }
    return { items: [], meta: {} };
  }
  function save(db) { fs.writeFileSync(file, JSON.stringify(db, null, 2)); }
  const clean = (s, n = 200) => String(s == null ? "" : s).trim().slice(0, n);
  const pub = (it) => ({ id: it.id, keyword: it.keyword, titleContains: it.titleContains || "", url: it.url, author: it.author, favorite: !!it.favorite, history: it.history || {}, lastCheckedAt: it.lastCheckedAt || null, lastError: it.lastError || null, createdAt: it.createdAt || null });
  let running = false;

  async function runChecks(ids) {
    if (running) return;
    running = true;
    try {
      for (const id of ids) {
        const db = load();
        const it = db.items.find((x) => x.id === id);
        if (!it) continue;
        await checkItem(it);
        const cur = load(); // 점검 중 변경 대비 저장 직전 재로딩
        const t = cur.items.find((x) => x.id === id);
        if (t) { t.history = it.history; t.lastCheckedAt = it.lastCheckedAt; t.lastError = it.lastError; t.postKey = it.postKey; t.postArt = it.postArt; t.matchKey = it.matchKey; t.matchArt = it.matchArt; save(cur); }
      }
    } finally { running = false; }
  }

  app.get("/api/cafe-comments", requireAdmin, (req, res) => {
    const db = load();
    res.json({ items: db.items.map(pub), running, lastAutoDate: db.meta.lastAutoDate || null });
  });

  app.post("/api/cafe-comments/items", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const keyword = clean(b.keyword, 100), url = clean(b.url, 500), author = clean(b.author, 80), titleContains = clean(b.titleContains, 200);
    if (!keyword) return res.status(400).json({ error: "invalid_input", message: "검색어를 입력하세요." });
    if (!(await toCafeRef(url))) return res.status(400).json({ error: "invalid_input", message: "카페 글 주소(cafe.naver.com/…/글번호 또는 공유 링크)를 입력하세요." });
    if (!author) return res.status(400).json({ error: "invalid_input", message: "확인할 댓글 작성자 닉네임을 입력하세요." });
    const db = load();
    const it = { id: crypto.randomUUID(), keyword, titleContains, url, author, history: {}, createdAt: new Date().toISOString(), createdBy: req.user.username };
    db.items.push(it);
    save(db);
    if (process.env.CAFE_COMMENT_AUTO !== "off") runChecks([it.id]).catch((e) => console.error("[cafe-comments] check failed:", e)); // 등록 즉시 1회 확인
    res.status(201).json({ item: pub(it) });
  });

  app.patch("/api/cafe-comments/items/:id", requireAdmin, async (req, res) => {
    const db = load();
    const it = db.items.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    if (typeof b.favorite === "boolean") it.favorite = b.favorite;
    if (b.keyword !== undefined) it.keyword = clean(b.keyword, 100) || it.keyword;
    if (b.titleContains !== undefined) it.titleContains = clean(b.titleContains, 200);
    if (b.author !== undefined) it.author = clean(b.author, 80) || it.author;
    if (b.url !== undefined) { const u = clean(b.url, 500); if (u && !(await toCafeRef(u))) return res.status(400).json({ error: "invalid_input", message: "카페 글 주소를 확인하세요." }); if (u) { it.url = u; delete it.matchKey; delete it.matchArt; delete it.postKey; delete it.postArt; } }
    save(db);
    res.json({ item: pub(it) });
  });

  app.delete("/api/cafe-comments/items/:id", requireAdmin, (req, res) => {
    const db = load();
    const before = db.items.length;
    db.items = db.items.filter((x) => x.id !== req.params.id);
    save(db);
    res.json({ ok: true, removed: before - db.items.length });
  });

  app.post("/api/cafe-comments/run", requireAdmin, async (req, res) => {
    if (running) return res.status(409).json({ error: "busy", message: "확인이 진행 중입니다." });
    const db = load();
    const sel = Array.isArray((req.body || {}).itemIds) ? req.body.itemIds : null;
    const ids = db.items.filter((x) => !sel || sel.includes(x.id)).map((x) => x.id);
    await runChecks(ids);
    const after = load();
    res.json({ ok: true, checked: ids.length, items: after.items.map(pub) });
  });

  // 진단: 서버가 이 글의 댓글을 읽는지 + 특정 작성자가 있는지 확인
  // 예) /api/cafe-comments/debug?url=cafe.naver.com/안사는게/12345&author=애비수
  app.get("/api/cafe-comments/debug", requireAdmin, async (req, res) => {
    const url = String(req.query.url || "").trim();
    const author = String(req.query.author || "").trim();
    if (!url) return res.status(400).json({ error: "invalid_input", message: "url 파라미터에 카페 글 주소를 넣으세요." });
    const r = await fetchComments(url);
    res.json({
      ok: r.ok,
      reason: r.reason,
      commentCount: r.comments.length,
      authors: [...new Set(r.comments.map((c) => c.nick))].slice(0, 50),
      authorPresent: author ? authorPresent(r.comments, author) : null,
      sample: r.comments.slice(0, 10),
      trace: r.trace,
    });
  });

  // 매일 KST AUTO_HOUR(기본 11시) 이후 첫 확인 시점에 전체 1회 자동 실행 (CAFE_COMMENT_AUTO=off 로 끔)
  if (process.env.CAFE_COMMENT_AUTO !== "off") {
    setInterval(() => {
      const kst = new Date(Date.now() + 9 * 3600e3);
      if (running || kst.getUTCHours() < AUTO_HOUR) return;
      const db = load();
      if (db.meta.lastAutoDate === today() || db.items.length === 0) return;
      db.meta.lastAutoDate = today();
      save(db);
      runChecks(db.items.map((i) => i.id)).catch((e) => console.error("[cafe-comments] auto run failed:", e));
    }, 10 * 60 * 1000).unref();
  }

  return { fetchComments, authorPresent, checkItem };
}

module.exports = { mount, fetchComments, authorPresent, toCafeRef };
