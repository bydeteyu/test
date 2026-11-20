// 카페 댓글 체크: 등록한 카페 글에 특정 작성자의 댓글이 유지되고 있는지 매일 확인한다.
// 1단계(현재): 서버가 그 글의 댓글을 읽을 수 있는지 확인하는 진단 엔드포인트.
//   - 네이버가 막혀 있는 개발 샌드박스에서는 실제 조회가 안 되므로, 배포(Railway)에서 실제 글로 검증한다.
const { normalize, resolveShortUrl, resolveClubId, UA } = require("./rank-tracker/core");

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
  let lastStatus = null, rawHit = false;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${clubId}/articles/${ref.art}/comments/pages/${page}?requestFrom=A&orderBy=asc${artQ}`;
    let res;
    try { res = await fetch(url, { headers }); } catch (e) { trace.error = e.message; break; }
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) return { ok: false, comments: [], reason: "가입(로그인) 필요 또는 비공개 카페 — 서버가 댓글을 읽을 수 없습니다.", trace: { ...trace, status: res.status } };
    if (!res.ok) { trace.status = res.status; break; }
    const text = await res.text();
    if (page === 1 && ref.artToken && text) rawHit = true; // 최소한 응답은 받음
    let j; try { j = JSON.parse(text); } catch { trace.parse = "non-json"; break; }
    const items = collectComments(j);
    all.push(...items);
    // 다음 페이지 유무 추정: 페이지 크기(보통 몇십 개)보다 적게 오면 마지막 페이지
    const more = j?.result?.comments?.pageInfo?.nextPage || (items.length >= 20);
    if (!more) break;
  }
  trace.status = lastStatus;
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

function mount(app, { dataDir } = {}) {
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));

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

  return { fetchComments, authorPresent };
}

module.exports = { mount, fetchComments, authorPresent, toCafeRef };
