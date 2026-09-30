// CLI(track.js)와 웹 앱(routes.js)이 함께 쓰는 네이버 검색 결과 조회 로직.
const { extractPosts, findTarget } = require("./parse");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BASE = process.env.NAVER_SEARCH_BASE || "https://search.naver.com"; // 테스트용 override

const CHANNELS = {
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
  },
};

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

// 검색 범위(maxRank)까지의 게시글을 순서대로 모은다.
async function collectPosts(ch, keyword, maxRank, delayMs) {
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
    await sleep(delayMs);
  }
  return out;
}

module.exports = { fetchHtml, extractPosts, CHANNELS, fetchKeyword, findTarget, today, sleep };
