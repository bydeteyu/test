// 카페 댓글 체크: 네트워크가 필요 없는 순수 로직 테스트 (주소 파싱, 작성자 존재 판정)
const test = require("node:test");
const assert = require("node:assert");
const { toCafeRef, authorPresent } = require("../cafe-comments");

test("toCafeRef: 카페 글 주소에서 카페/글 번호를 뽑는다", async () => {
  const a = await toCafeRef("https://cafe.naver.com/imsanbu/80153775");
  assert.strictEqual(a.club, "imsanbu");
  assert.strictEqual(a.art, "80153775");
  const b = await toCafeRef("cafe.naver.com/12345678/42"); // 카페 번호로도
  assert.strictEqual(b.club, "12345678");
  assert.strictEqual(b.art, "42");
  assert.strictEqual(await toCafeRef("https://example.com/x"), null); // 카페 글 아님
  assert.strictEqual(await toCafeRef(""), null);
});

test("authorPresent: 삭제되지 않은 해당 작성자 댓글이 있으면 true", () => {
  const cs = [
    { nick: "애비수", content: "추천해요", deleted: false },
    { nick: "다른사람", content: "저도요", deleted: false },
  ];
  assert.strictEqual(authorPresent(cs, "애비수"), true);
  assert.strictEqual(authorPresent(cs, " 애비수 "), true); // 공백 무시
  assert.strictEqual(authorPresent(cs, "없는사람"), false);
  assert.strictEqual(authorPresent([{ nick: "애비수", content: "x", deleted: true }], "애비수"), false); // 삭제된 건 제외
});
