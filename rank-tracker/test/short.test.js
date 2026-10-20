const test = require("node:test");
const assert = require("node:assert");
const { ensureMatchKey, resolveShortUrl } = require("../core");

const CAFE = "https://cafe.naver.com/skybluezw4rh?iframe_url_utf8=%2Fca-fe%2Fcafes%2F29434212%2Farticles%2F11933505%253Fart%253DTOKEN.abc%2526query%253Dx";

function mockFetch(map, calls = []) {
  global.fetch = async (u) => {
    calls.push(String(u));
    const loc = map[String(u)];
    return loc ? { status: 302, headers: { get: (h) => (h.toLowerCase() === "location" ? loc : null) } } : { status: 200, headers: { get: () => null } };
  };
  return calls;
}

test("naver.me 단축 주소를 따라가 카페 글 키와 토큰(art)을 얻는다", async () => {
  mockFetch({ "https://naver.me/xcgUnsUt": CAFE });
  const item = { match: "https://naver.me/xcgUnsUt" };
  await ensureMatchKey(item);
  assert.strictEqual(item.matchKey, "cafe.naver.com/29434212/11933505");
  assert.strictEqual(item.matchArt, "TOKEN.abc");
});

test("카페 글 주소는 네트워크 없이 바로 키로 바꾼다", async () => {
  const calls = mockFetch({});
  const item = { match: "cafe.naver.com/imsanbu/80153775" };
  await ensureMatchKey(item);
  assert.strictEqual(item.matchKey, "cafe.naver.com/imsanbu/80153775");
  assert.strictEqual(calls.length, 0);
});

test("네이버가 아닌 주소는 따라가지 않는다", async () => {
  const calls = mockFetch({});
  assert.strictEqual(await resolveShortUrl("https://evil.example.com/x"), null);
  const item = { match: "https://evil.example.com/x" };
  await ensureMatchKey(item);
  assert.strictEqual(item.matchKey, undefined);
  assert.strictEqual(calls.length, 0);
});

test("리다이렉트 중 네이버가 아닌 주소로 가면 중단한다", async () => {
  const calls = mockFetch({ "https://naver.me/a": "https://evil.example.com/steal" });
  assert.strictEqual(await resolveShortUrl("https://naver.me/a"), null);
  assert.deepStrictEqual(calls, ["https://naver.me/a"]);
});
