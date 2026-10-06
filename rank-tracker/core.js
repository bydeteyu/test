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

// 카페 글 조회수 조회(비공식 카페 글 API, 공개 글만). 실패하면 null — 순위 기록에는 영향 없다.
// key: "cafe.naver.com/{카페명 또는 카페번호}/{글번호}"
const viewCache = new Map(); // key -> { t, v }  (같은 확인 중 통합/카페 중복 조회만 막는 짧은 캐시)
const VIEW_CACHE_MS = 60 * 1000;
async function fetchCafeViews(key, { debug = false } = {}) {
  const m = /^cafe\.naver\.com\/([^/]+)\/(\d+)$/.exec(key || "");
  if (!m) return debug ? { error: "카페 글 주소가 아님" } : null;
  const cached = viewCache.get(key);
  if (!debug && cached && Date.now() - cached.t < VIEW_CACHE_MS) return cached.v;
  const headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://cafe.naver.com/" };
  const trace = {};
  let views = null;
  try {
    let clubId = /^\d+$/.test(m[1]) ? m[1] : null;
    if (!clubId) { // 카페명 → 카페번호: 카페 첫 화면 HTML 에서 찾는다
      const html = await (await fetch(`https://cafe.naver.com/${encodeURIComponent(m[1])}`, { headers: { ...headers, Accept: "text/html" } })).text();
      const mm = /(?:clubid|clubId|cafes\/)[=":\s]*(\d{5,})/.exec(html);
      clubId = mm ? mm[1] : null;
    }
    trace.clubId = clubId;
    if (clubId) {
      const url = `https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${clubId}/articles/${m[2]}?query=&useCafeId=true&requestFrom=A`;
      const res = await fetch(url, { headers });
      trace.status = res.status;
      if (res.ok) {
        const j = await res.json();
        const n = j?.result?.article?.readCount ?? j?.result?.readCount;
        views = Number.isFinite(Number(n)) ? Number(n) : null;
        trace.shape = Object.keys(j?.result || {});
      }
    }
  } catch (e) {
    trace.error = e.message;
  }
  if (debug) return { views, ...trace };
  if (views !== null) viewCache.set(key, { t: Date.now(), v: views }); // 실패(null)는 캐시하지 않음
  return views;
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
