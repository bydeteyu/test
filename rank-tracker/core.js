// CLI(track.js)와 웹 앱(routes.js)이 함께 쓰는 네이버 검색 결과 조회 로직.
const { extractPosts, findTarget, normalize } = require("./parse");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BASE = process.env.NAVER_SEARCH_BASE || "https://search.naver.com"; // 테스트용 override

// 순위 조회 방식. 기본(scrape)은 네이버 검색 화면을 읽어 통합검색·카페 탭 순위를 기록한다.
// 카페 탭이 막히거나 결과가 비면 네이버 검색 오픈 API(카페글)로 대신 조회한다(키가 있을 때).
// 통합검색은 공식 API가 없어 차단되면 조회 실패("-")로 기록된다.
// RANK_SOURCE=api 로 하면 공식 API만 써서 카페·블로그 순위를 기록한다(화면 순위와 다를 수 있음).
const SOURCE = process.env.RANK_SOURCE === "api" ? "api" : "scrape";

const API_CHANNELS = {
  cafe: { label: "카페", api: "cafearticle" },
  blog: { label: "블로그", api: "blog" },
};

const SCRAPE_CHANNELS = {
  // 통합검색은 페이지네이션이 없어 1페이지의 게시글 순서가 곧 순위
  integrated: {
    label: "통합",
    url: (q) => `${BASE}/search.naver?ssc=tab.nx.all&where=nexearch&sm=tab_jum&query=${encodeURIComponent(q)}`,
    // 위 주소가 403 으로 막히면 차례로 시도할 대체 주소
    altUrls: (q) => [
      `${BASE}/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(q)}`,
      `${BASE}/search.naver?query=${encodeURIComponent(q)}`,
    ],
  },
  // 카페 탭은 10개 안팎씩 끊어 start=11, 21… 로 넘기며 maxRank까지 모은다
  cafe: {
    label: "카페",
    url: (q, start) => `${BASE}/search.naver?ssc=tab.cafe.all&query=${encodeURIComponent(q)}&start=${start}`,
    onlyTypes: ["cafe"],
    paged: true,
    apiFallback: "cafearticle", // 화면 조회 실패 시 대체
  },
};

const CHANNELS = SOURCE === "scrape" ? SCRAPE_CHANNELS : API_CHANNELS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST 기준 날짜

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer": "https://www.naver.com/",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-site",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 403/429(요청 제한)이면 잠시 쉬었다 재시도하고, 그래도 안 되면 채널의 대체 주소를 차례로 시도한다.
async function fetchWithFallback(ch, keyword, start, delayMs) {
  const urls = [ch.url(keyword, start), ...(ch.altUrls ? ch.altUrls(keyword, start) : [])];
  let lastErr;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetchHtml(url);
      } catch (e) {
        lastErr = e;
        if (!/HTTP (403|429|5\d\d)/.test(e.message)) throw e;
        await sleep(delayMs * (attempt + 1) + 1000);
      }
    }
  }
  throw lastErr;
}

const apiConfigured = () => !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);

const stripTags = (t) =>
  String(t || "").replace(/<[^>]+>/g, "").replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) => ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" }[e]));

// 네이버 검색 오픈 API (관련도순). 결과 순서가 곧 해당 검색의 순위.
async function collectApiPosts(ch, keyword, maxRank) {
  if (!apiConfigured()) throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경 변수가 없습니다");
  const all = [];
  const seen = new Set();
  for (let start = 1; start <= 1000 && all.length < maxRank; start += 100) {
    const url = `${process.env.NAVER_API_BASE || "https://openapi.naver.com"}/v1/search/${ch.api}.json?query=${encodeURIComponent(keyword)}&display=100&start=${start}&sort=sim`;
    const res = await fetch(url, { headers: { "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID, "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET } });
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const items = (await res.json()).items || [];
    for (const it of items) {
      const n = normalize(it.link);
      const key = n ? n.key : String(it.link).replace(/^https?:\/\//, "");
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ rank: all.length + 1, type: n ? n.type : ch.api, key, title: stripTags(it.title) });
    }
    if (items.length < 100) break;
  }
  const out = all.slice(0, maxRank);
  out.pageText = "";
  out.anchors = [];
  return out;
}

// 카페 글 조회수 조회(비공식 카페 글 API, 공개 글만).
// key: "cafe.naver.com/{카페명 또는 카페번호}/{글번호}"
// 결과: { views: 숫자|null, reason: 실패 사유(짧은 한글) | undefined } — 실패해도 순위 기록에는 영향 없다.
const viewCache = new Map(); // key -> { t, v }  (같은 확인 중 통합/카페 중복 조회만 막는 짧은 캐시)
const VIEW_CACHE_MS = 60 * 1000;
const CLUB_ID_PATTERNS = [/g_sClubId\s*=\s*["'](\d+)["']/, /\/cafes\/(\d+)/, /clubid[=":\s]*(\d{5,})/i, /"cafeId"\s*:\s*"?(\d{5,})/];

async function resolveClubId(name, headers) {
  for (const [url, ua] of [[`https://cafe.naver.com/${encodeURIComponent(name)}`, UA], [`https://m.cafe.naver.com/${encodeURIComponent(name)}`, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"]]) {
    try {
      const res = await fetch(url, { headers: { ...headers, "User-Agent": ua, Accept: "text/html" } });
      const html = await res.text();
      for (const re of CLUB_ID_PATTERNS) { const m = re.exec(html); if (m) return m[1]; }
    } catch { /* 다음 주소 시도 */ }
  }
  return null;
}

async function lookupCafeViews(key, art) {
  const m = /^cafe\.naver\.com\/([^/]+)\/(\d+)$/.exec(key || "");
  if (!m) return { views: null, reason: "카페 글이 아니거나 글 주소를 알 수 없음", trace: { key } };
  const headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://cafe.naver.com/" };
  const trace = { key };
  try {
    // art: 검색 결과 링크에 붙는 검색 유입 토큰. 회원공개 카페 글도 "검색에서 들어온 것"으로 열리게 해 주는 값이라 함께 보낸다.
    const artQ = art ? `&art=${encodeURIComponent(art)}` : "";
    trace.hasArt = !!art;
    const clubId = /^\d+$/.test(m[1]) ? m[1] : await resolveClubId(m[1], headers);
    trace.clubId = clubId;
    const attempts = [];
    if (clubId) attempts.push(`https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${clubId}/articles/${m[2]}?query=&useCafeId=true&requestFrom=A${artQ}`);
    if (art) attempts.push(`https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${encodeURIComponent(m[1])}/articles/${m[2]}?query=&useCafeId=false&requestFrom=A${artQ}`); // 카페 번호를 모를 때 카페명으로
    if (attempts.length === 0) return { views: null, reason: "카페 번호를 찾지 못함", trace };
    let res;
    for (const url of attempts) {
      res = await fetch(url, { headers });
      trace.status = res.status;
      if (res.ok) break;
    }
    if (res.status === 401 || res.status === 403) return { views: null, reason: art ? "검색 유입으로도 열리지 않는 글(비공개)" : "가입 필요 또는 비공개 카페", trace };
    if (res.status === 429 || res.status >= 500) return { views: null, reason: "네이버가 조회를 제한함", trace };
    if (!res.ok) return { views: null, reason: `조회수 조회 실패(HTTP ${res.status})`, trace };
    const j = await res.json();
    trace.keys = Object.keys(j || {});
    trace.resultKeys = Object.keys(j?.result || {});
    const n = j?.result?.article?.readCount ?? j?.result?.readCount;
    if (Number.isFinite(Number(n)) && n !== null && n !== undefined) return { views: Number(n), trace };
    if (j?.result?.errorCode || j?.message?.error) return { views: null, reason: art ? "검색 유입으로도 열리지 않는 글(비공개)" : "가입 필요 또는 비공개 카페", trace: { ...trace, error: j.result?.errorCode || j.message.error } };
    return { views: null, reason: "응답에 조회수가 없음", trace };
  } catch (e) {
    trace.error = e.message;
    return { views: null, reason: "조회수 조회 중 오류", trace };
  }
}

async function fetchCafeViews(key, { debug = false, art = null } = {}) {
  const cached = viewCache.get(key);
  if (!debug && cached && Date.now() - cached.t < VIEW_CACHE_MS) return { views: cached.v };
  const r = await lookupCafeViews(key, art);
  if (debug) return { views: r.views, reason: r.reason, ...r.trace };
  if (r.views !== null) viewCache.set(key, { t: Date.now(), v: r.views }); // 실패는 캐시하지 않음
  return { views: r.views, reason: r.reason };
}

// 검색 범위(maxRank)까지의 게시글을 순서대로 모은다.
async function collectPosts(ch, keyword, maxRank, delayMs) {
  if (ch.api) return collectApiPosts(ch, keyword, maxRank);
  try {
    const out = await collectScrapedPosts(ch, keyword, maxRank, delayMs);
    if (out.length > 0 || !ch.apiFallback || !apiConfigured()) return out;
  } catch (e) {
    if (!ch.apiFallback || !apiConfigured()) throw e;
    console.error(`[rank] ${keyword}/${ch.label}: 화면 조회 실패(${e.message}) → 공식 API로 대체`);
  }
  return collectApiPosts({ api: ch.apiFallback, label: ch.label }, keyword, maxRank);
}

async function collectScrapedPosts(ch, keyword, maxRank, delayMs) {
  const all = [];
  const seen = new Set();
  let pageText = "";
  const anchors = [];
  for (let start = 1, page = 0; page < 8 && all.length < maxRank; page++) {
    const posts = extractPosts(await fetchWithFallback(ch, keyword, start, delayMs), { onlyTypes: ch.onlyTypes });
    pageText += " " + posts.pageText;
    anchors.push(...posts.anchors);
    const fresh = posts.filter((p) => !seen.has(p.key));
    fresh.forEach((p) => { seen.add(p.key); all.push({ ...p, rank: all.length + 1 }); });
    if (!ch.paged || fresh.length === 0) break; // 더 이상 새 글이 없으면 중단
    start += posts.length;
    await sleep(delayMs);
  }
  const out = all.slice(0, maxRank);
  out.pageText = pageText;
  out.anchors = anchors;
  return out;
}

// 키워드 하나에 대해 채널별 게시글 목록을 가져온다. 실패한 채널은 null (미노출과 구분).
async function fetchKeyword(keyword, { maxRank = 50, delayMs = 3000 } = {}) {
  const out = {};
  for (const [channel, ch] of Object.entries(CHANNELS)) {
    try {
      out[channel] = await collectPosts(ch, keyword, maxRank, delayMs);
    } catch (e) {
      console.error(`[rank] ${keyword}/${ch.label}: ${e.message}`);
      out[channel] = null;
    }
    if (!ch.api) await sleep(delayMs);
  }
  return out;
}

module.exports = { fetchCafeViews, SOURCE, apiConfigured, fetchHtml, extractPosts, CHANNELS, fetchKeyword, findTarget, today, sleep };
