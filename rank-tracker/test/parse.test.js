const test = require("node:test");
const assert = require("node:assert");
const { extractPosts, findTarget } = require("../parse");

const html = `
<a href="https://blog.naver.com/aaa/111"><img></a>
<a href="https://blog.naver.com/aaa/111">첫번째 블로그 글</a>
<a href="https://cafe.naver.com/mycafe/222">다이어트 한약 후기 공유</a>
<a href="https://example.com/x">외부</a>
<a href="https://cafe.naver.com/ArticleRead.nhn?clubid=99&articleid=333">다른 카페 글</a>`;

test("통합검색: 중복 링크는 한 번만 세고 순서대로 순위를 매긴다", () => {
  const p = extractPosts(html);
  assert.deepStrictEqual(p.map((x) => [x.rank, x.key]), [
    [1, "blog.naver.com/aaa/111"], [2, "cafe.naver.com/mycafe/222"], [3, "cafe.naver.com/99/333"],
  ]);
  assert.strictEqual(p[0].title, "첫번째 블로그 글");
});
test("카페 탭: 카페 글만 세면 순위가 다시 매겨진다", () => {
  const p = extractPosts(html, { onlyTypes: ["cafe"] });
  assert.strictEqual(findTarget(p, { match: "cafe.naver.com/mycafe/222" }).rank, 1);
});
test("제목 포함 매칭 / 미노출", () => {
  const p = extractPosts(html);
  assert.strictEqual(findTarget(p, { titleContains: "다이어트 한약" }).rank, 2);
  assert.strictEqual(findTarget(p, { match: "blog.naver.com/zzz/1" }), null);
});
