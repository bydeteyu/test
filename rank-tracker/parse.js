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
  return posts;
}

function findTarget(posts, target) {
  const hit = posts.find((p) => {
    if (target.match && p.key.includes(target.match.replace(/^https?:\/\//, "").replace(/^(m|www)\./, ""))) return true;
    if (target.titleContains && p.title.includes(target.titleContains)) return true;
    return false;
  });
  return hit || null;
}

module.exports = { extractPosts, findTarget, normalize };
