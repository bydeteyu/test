// CLI(track.js)와 웹 앱(routes.js)이 함께 쓰는 네이버 검색 결과 조회 로직.
const { extractPosts, findTarget } = require("./parse");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BASE = process.env.NAVER_SEARCH_BASE || "https://search.naver.com"; // 테스트용 override

const CHANNELS = {
  // 통합검색은 페이지네이션이 없어 1페이지의 게시글 순서가 곧 순위
  integrated: {
    label: "통합",
    url: (q) => `${BASE}/search.naver?where=nexearch&query=${encodeURIComponent(q)}`,
  },
  // 카페 탭은 10개 안팎씩 끊어 start=11, 21… 로 넘기며 maxRank까지 모은다
  cafe: {
    label: "카페",
    url: (q, start) => `${BASE}/search.naver?ssc=tab.cafe.all&query=${encodeURIComponent(q)}&start=${start}`,
    onlyTypes: ["cafe"],
    paged: true,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST 기준 날짜

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 검색 범위(maxRank)까지의 게시글을 순서대로 모은다.
async function collectPosts(ch, keyword, maxRank, delayMs) {
  const all = [];
  const seen = new Set();
  let pageText = "";
  for (let start = 1, page = 0; page < 8 && all.length < maxRank; page++) {
    const posts = extractPosts(await fetchHtml(ch.url(keyword, start)), { onlyTypes: ch.onlyTypes });
    pageText += " " + posts.pageText;
    const fresh = posts.filter((p) => !seen.has(p.key));
    fresh.forEach((p) => { seen.add(p.key); all.push({ ...p, rank: all.length + 1 }); });
    if (!ch.paged || fresh.length === 0) break; // 더 이상 새 글이 없으면 중단
    start += posts.length;
    await sleep(delayMs);
  }
  const out = all.slice(0, maxRank);
  out.pageText = pageText;
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
    await sleep(delayMs);
  }
  return out;
}

module.exports = { fetchHtml, extractPosts, CHANNELS, fetchKeyword, findTarget, today, sleep };
