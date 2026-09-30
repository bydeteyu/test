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
    // 클릭 후 주소: /카페명?iframe_url_utf8=/ca-fe/cafes/{카페번호}/articles/{글번호}%3F...
    const iframe = u.searchParams.get("iframe_url_utf8");
    if (iframe) {
      const im = iframe.match(/\/cafes\/(\d+)\/articles\/(\d+)/) || iframe.match(/articleid(?:=|%3D)(\d+)/i);
      if (im) return { type: "cafe", key: `cafe.naver.com/${im.length === 3 ? im[1] : parts[0]}/${im[im.length - 1]}` };
    }
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

// 링크 주소로 게시글을 식별하지 못할 때를 위한 대체 순위 계산용:
// 문서 순서대로 "제목처럼 보이는 링크"(텍스트가 충분히 길고, 같은 글은 한 번만)를 모은다.
function titleAnchors($) {
  const out = [];
  const seenText = new Set();
  const seenHref = new Set();
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "");
    if (!/^https?:\/\//.test(href)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const sq = text.replace(/\s+/g, "");
    if (sq.length < 12 || /^RE\b/.test(text) || /더보기|도움말|Keep/.test(text)) return; // 댓글 카드·메뉴성 링크 제외
    const hk = href.split("#")[0].split("?")[0];
    if (seenText.has(sq) || seenHref.has(hk)) return;
    seenText.add(sq);
    seenHref.add(hk);
    out.push({ text, href });
  });
  return out;
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
  posts.anchors = titleAnchors($);
  posts.pageText = $("body").text().replace(/\s+/g, " ").trim(); // 링크 패턴으로 못 잡은 경우의 제목 검색용
  return posts;
}

// 카페 글은 카페명(imsanbu)과 카페번호(10094499) 두 가지 주소로 나올 수 있어, 글번호가 같고
// 카페 식별자가 같거나 (하나는 이름, 하나는 번호라) 비교할 수 없는 경우에도 같은 글로 본다.
function sameCafePost(postKey, matchStr) {
  const raw = String(matchStr).trim();
  const ref = normalize(/^https?:\/\//.test(raw) ? raw : "https://" + raw);
  if (!ref || ref.type !== "cafe") return null; // 카페 주소가 아니면 판단하지 않음
  const [, pc, pa] = postKey.split("/");
  const [, rc, ra] = ref.key.split("/");
  if (pa !== ra) return false;
  const num = (x) => /^\d+$/.test(x);
  return pc === rc || num(pc) !== num(rc);
}

const squash = (s) => String(s).replace(/\s+/g, "");

// pageText 를 넘기면(통합검색용) 링크 주소로 식별하지 못한 글도 페이지 본문에 제목이 있으면 노출로 본다.
// 이 경우 순위는 알 수 없어 rank 는 null.
function findTarget(posts, target, { pageText, anchors } = {}) {
  const t = target.titleContains ? squash(target.titleContains) : "";
  const hit = posts.find((p) => {
    if (target.match) {
      const same = p.type === "cafe" ? sameCafePost(p.key, target.match) : null;
      if (same !== null) { if (same) return true; }
      else if (p.key.includes(target.match.replace(/^https?:\/\//, "").replace(/^(m|www)\./, ""))) return true;
    }
    if (t && squash(p.title).includes(t)) return true;
    return false;
  });
  if (hit) return hit;
  if (t && anchors) {
    const i = anchors.findIndex((a) => squash(a.text).includes(t));
    if (i >= 0) return { rank: i + 1, title: anchors[i].text, estimated: true }; // 제목 링크 순서 기준 추정 순위
  }
  if (t && pageText && squash(pageText).includes(t)) return { rank: null, title: target.titleContains, viaText: true };
  return null;
}

module.exports = { extractPosts, findTarget, normalize };
