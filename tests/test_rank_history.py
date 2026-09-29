import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATA_DIR"] = tempfile.mkdtemp()

import rank_history as rh  # noqa: E402

# 네이버 검색 결과 구조를 흉내낸 HTML: 카페명 링크 → 제목 링크 → 썸네일 링크 → 댓글 미리보기 링크(같은 글)
def cafe_block(cafe, slug, num, title):
    return (f'<div><a href="https://cafe.naver.com/{slug}">{cafe}</a>'
            f'<a href="https://cafe.naver.com/{slug}/{num}"><img></a>'
            f'<a href="https://cafe.naver.com/{slug}/{num}">{title}</a>'
            f'<a href="https://cafe.naver.com/{slug}/{num}?commentId=9">RE 아주 긴 댓글 미리보기 텍스트가 제목보다 훨씬 길게 이어집니다 정말로</a></div>')

BLOG = '<div><a href="https://blog.naver.com/abc/111">블로그 후기 글</a></div>'
INTEGRATED = BLOG + cafe_block("시험관아기 대표카페", "sihum", 500, "대추밭백한의원 다녀왔어요^^") + cafe_block("맘카페", "mom", 600, "경주 대추밭백한의원 예약 실패")
CAFE_TAB = "".join(cafe_block(f"카페{i}", f"c{i}", 1000 + i, f"카페글 {i}") for i in range(1, 17)) + \
    cafe_block("시험관아기 대표카페", "sihum", 500, "대추밭백한의원 다녀왔어요^^")


class ExtractTest(unittest.TestCase):
    def test_integrated_counts_blog_and_cafe_once(self):
        posts = rh.extract_ranked(INTEGRATED)
        self.assertEqual([(p["rank"], p["type"]) for p in posts], [(1, "blog"), (2, "cafe"), (3, "cafe")])
        self.assertEqual(posts[1]["title"], "대추밭백한의원 다녀왔어요^^")  # 댓글 미리보기가 제목을 덮어쓰지 않음
        self.assertEqual(posts[1]["cafe"], "시험관아기 대표카페")
        self.assertEqual(posts[1]["link"], "https://cafe.naver.com/sihum/500")

    def test_cafe_tab_only_cafe_posts(self):
        posts = rh.extract_ranked(CAFE_TAB, only_cafe=True)
        self.assertEqual(len(posts), 17)
        self.assertEqual(posts[-1]["rank"], 17)

    def test_top_n_limit(self):
        self.assertEqual(len(rh.extract_ranked(CAFE_TAB, only_cafe=True, top_n=5)), 5)


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.integrated = rh.extract_ranked(INTEGRATED)
        self.cafe = rh.extract_ranked(CAFE_TAB, only_cafe=True)

    def test_title_match_ignores_spaces(self):
        item = {"title_contains": "대추밭 백한의원 다녀왔어요"}
        self.assertEqual(rh.judge(self.integrated, item), {"status": "hit", "rank": 2, "title": "대추밭백한의원 다녀왔어요^^"})
        self.assertEqual(rh.judge(self.cafe, item)["rank"], 17)  # 17위 → 20위 안

    def test_url_match_variants(self):
        for url in ("https://cafe.naver.com/sihum/500", "cafe.naver.com/sihum/500", "https://m.cafe.naver.com/sihum/500"):
            self.assertEqual(rh.judge(self.integrated, {"url": url})["rank"], 2, url)

    def test_miss_outside_track_range_and_error(self):
        item = {"title_contains": "대추밭백한의원 다녀왔어요"}
        self.assertEqual(rh.judge(self.cafe, item, top=10), {"status": "miss"})
        self.assertEqual(rh.judge(None, item), {"status": "error"})


class RecordTest(unittest.TestCase):
    def test_record_history_and_failed_day_keeps_snapshot(self):
        item = rh.add_item("대추밭백한의원", "다녀왔어요", "")
        fake = lambda kw: {"integrated": INTEGRATED, "cafe": CAFE_TAB}
        rh.run_check(["대추밭백한의원"], fetcher=fake)
        d = rh.today()
        h = rh.list_items()[0]["history"][d]
        self.assertEqual((h["integrated"]["rank"], h["cafe"]["rank"]), (2, 17))
        self.assertEqual(len(rh.get_snapshots("대추밭백한의원")[d]["cafe"]), 17)

        def boom(kw):
            raise RuntimeError("blocked")
        rh.MAX_ATTEMPTS, orig = 1, rh.MAX_ATTEMPTS
        rh.run_check(["대추밭백한의원"], fetcher=boom)
        rh.MAX_ATTEMPTS = orig
        # 같은 날 실패해도 스냅샷은 보존, 추적 기록만 error 로 표시
        self.assertEqual(len(rh.get_snapshots("대추밭백한의원")[d]["cafe"]), 17)
        self.assertEqual(rh.list_items()[0]["history"][d]["cafe"], {"status": "error"})
        rh.delete_item(item["id"])
        self.assertEqual(rh.list_items(), [])


if __name__ == "__main__":
    unittest.main()
