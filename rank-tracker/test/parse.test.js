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

test("신형 카페 주소(/f-e/cafes/N/articles/M)도 게시글로 인식", () => {
  const p = extractPosts('<a href="https://cafe.naver.com/f-e/cafes/123/articles/456?boardtype=L">경주 대추밭백한의원 예약 실패</a>');
  assert.strictEqual(p[0].key, "cafe.naver.com/123/456");
});
test("통합검색: 링크로 못 잡아도 본문에 제목이 있으면 노출(순위 없음), 공백 차이 무시", () => {
  const p = extractPosts('<div><a href="https://example.com/x">경주 <b>대추밭백</b> 한의원 예약 실패..</a> 취소표 오픈시간</div>');
  assert.strictEqual(findTarget(p, { titleContains: "대추밭백한의원 예약 실패" }), null);
  const hit = findTarget(p, { titleContains: "대추밭백한의원 예약 실패" }, { pageText: p.pageText });
  assert.ok(hit && hit.rank === null);
  assert.strictEqual(findTarget(p, { titleContains: "없는 문구" }, { pageText: p.pageText }), null);
});

test("통합검색: 주소로 식별 못해도 제목 링크 순서로 추정 순위를 매긴다", () => {
  const p = extractPosts(`<a href="https://a.go.kr/x">경주 대추밭 백한의원의 임신 동의보감 도서관</a>
    <a href="https://r.naver.com/1">대추밭백한의원 다녀왔어요^^ 후기 입니다</a>
    <a href="https://r.naver.com/2">경주 대추밭백한의원 예약 실패.. 취소표 오픈시간</a>`);
  const o = { pageText: p.pageText, anchors: p.anchors };
  const hit = findTarget(p, { titleContains: "예약 실패.. 취소표" }, o);
  assert.strictEqual(hit.rank, 3);
  assert.strictEqual(findTarget(p, { titleContains: "다녀왔어요^^" }, o).rank, 2);
});
