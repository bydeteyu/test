// 네이버 검색 결과 HTML에서 게시글(블로그/카페 등) 링크를 문서 순서대로 뽑아 순위를 매긴다.
// 네이버는 CSS 클래스명이 자주 바뀌므로 클래스 대신 "링크 URL 패턴"으로 게시글을 식별한다.
const cheerio = require("cheerio");

// 정규화된 게시글 키: 같은 글이 썸네일/제목/본문 링크로 여러 번 나와도 한 번만 센다.
function normalize(href) {
  let u;
  try {
    u = new URL(href, "https://search.naver.com");
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(m|www)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "cafe.naver.com") {
    // /카페명/글번호  또는 /ArticleRead.nhn?clubid=..&articleid=..
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) return { type: "cafe", key: `cafe.naver.com/${parts[0]}/${parts[1]}` };
    // 신형 주소: /f-e/cafes/{카페번호}/articles/{글번호}, /ca-fe/cafes/{카페번호}/articles/{글번호}
    const m = u.pathname.match(/\/cafes\/(\d+)\/articles\/(\d+)/);
    if (m) return { type: "cafe", key: `cafe.naver.com/${m[1]}/${m[2]}` };
    const id = u.searchParams.get("articleid");
    const club = u.searchParams.get("clubid");
    if (id && club) return { type: "cafe", key: `cafe.naver.com/${club}/${id}` };
    return null;
  }
  if (host === "blog.naver.com") {
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) return { type: "blog", key: `blog.naver.com/${parts[0]}/${parts[1]}` };
    const id = u.searchParams.get("blogId");
    const no = u.searchParams.get("logNo");
    if (id && no) return { type: "blog", key: `blog.naver.com/${id}/${no}` };
    return null;
  }
  if (host === "in.naver.com" || host === "post.naver.com" || host === "kin.naver.com" || host === "tv.naver.com") {
    return { type: host.split(".")[0], key: host + u.pathname };
  }
  return null;
}

function extractPosts(html, { onlyTypes } = {}) {
  const $ = cheerio.load(html);
  const seen = new Map(); // key -> post
  const posts = [];
  $("a[href]").each((_, el) => {
    const n = normalize($(el).attr("href"));
    if (!n) return;
    if (onlyTypes && !onlyTypes.includes(n.type)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const existing = seen.get(n.key);
    if (existing) {
      // 제목 링크가 썸네일 링크(텍스트 없음)보다 뒤에 올 수 있어 더 긴 텍스트로 보강
      if (text.length > existing.title.length) existing.title = text;
      return;
    }
    const post = { rank: posts.length + 1, type: n.type, key: n.key, title: text };
    seen.set(n.key, post);
    posts.push(post);
  });
  posts.pageText = $("body").text().replace(/\s+/g, " ").trim(); // 링크 패턴으로 못 잡은 경우의 제목 검색용
  return posts;
}

const squash = (s) => String(s).replace(/\s+/g, "");

// pageText 를 넘기면(통합검색용) 링크 주소로 식별하지 못한 글도 페이지 본문에 제목이 있으면 노출로 본다.
// 이 경우 순위는 알 수 없어 rank 는 null.
function findTarget(posts, target, { pageText } = {}) {
  const t = target.titleContains ? squash(target.titleContains) : "";
  const hit = posts.find((p) => {
    if (target.match && p.key.includes(target.match.replace(/^https?:\/\//, "").replace(/^(m|www)\./, ""))) return true;
    if (t && squash(p.title).includes(t)) return true;
    return false;
  });
  if (hit) return hit;
  if (t && pageText && squash(pageText).includes(t)) return { rank: null, title: target.titleContains, viaText: true };
  return null;
}

module.exports = { extractPosts, findTarget, normalize };
