"""Unit tests — API calls are fully mocked; no real credentials needed."""

import csv
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))

# Set dummy env vars before importing the module
os.environ.setdefault("NAVER_API_KEY", "test_key")
os.environ.setdefault("NAVER_SECRET_KEY", "test_secret")
os.environ.setdefault("NAVER_CUSTOMER_ID", "1234567")

import naver_keywords as nk

# ── 모의 API 응답 ─────────────────────────────────────────
MOCK_KEYWORD_LIST = [
    {"relKeyword": "다이어트 식단", "monthlyPcQcCnt": 5000, "monthlyMobileQcCnt": 15000, "compIdx": "낮음"},
    {"relKeyword": "헬스 루틴", "monthlyPcQcCnt": 3000, "monthlyMobileQcCnt": 8000, "compIdx": "보통"},
    {"relKeyword": "다이어트 약", "monthlyPcQcCnt": 7000, "monthlyMobileQcCnt": 20000, "compIdx": "높음"},
    {"relKeyword": "도박 게임", "monthlyPcQcCnt": 9000, "monthlyMobileQcCnt": 30000, "compIdx": "낮음"},  # RISK
]


def _mock_response(kw_list):
    mock = MagicMock()
    mock.raise_for_status.return_value = None
    mock.json.return_value = {"keywordList": kw_list}
    return mock


# ── score() 단위 테스트 ────────────────────────────────────
class TestScore:
    def test_low_competition_boosts_score(self):
        low = {"relKeyword": "테스트", "monthlyPcQcCnt": 1000, "monthlyMobileQcCnt": 1000, "compIdx": "낮음"}
        high = {"relKeyword": "테스트", "monthlyPcQcCnt": 1000, "monthlyMobileQcCnt": 1000, "compIdx": "높음"}
        assert nk.score(low) > nk.score(high)

    def test_risk_term_zeroes_score(self):
        risky = {"relKeyword": "도박 사이트", "monthlyPcQcCnt": 50000, "monthlyMobileQcCnt": 50000, "compIdx": "낮음"}
        assert nk.score(risky) == 0.0

    def test_safe_term_positive_score(self):
        safe = {"relKeyword": "운동화 추천", "monthlyPcQcCnt": 5000, "monthlyMobileQcCnt": 5000, "compIdx": "보통"}
        assert nk.score(safe) > 0

    def test_zero_volume_gives_zero(self):
        empty = {"relKeyword": "키워드", "monthlyPcQcCnt": 0, "monthlyMobileQcCnt": 0, "compIdx": "낮음"}
        assert nk.score(empty) == 0.0

    def test_english_comp_idx(self):
        kw_low = {"relKeyword": "test", "monthlyPcQcCnt": 1000, "monthlyMobileQcCnt": 0, "compIdx": "LOW"}
        kw_high = {"relKeyword": "test", "monthlyPcQcCnt": 1000, "monthlyMobileQcCnt": 0, "compIdx": "HIGH"}
        assert nk.score(kw_low) > nk.score(kw_high)


# ── collect() 통합 테스트 ─────────────────────────────────
class TestCollect:
    @patch("naver_keywords.fetch_related_keywords")
    def test_results_sorted_descending(self, mock_fetch, tmp_path):
        mock_fetch.return_value = MOCK_KEYWORD_LIST
        seed_file = tmp_path / "seeds.txt"
        seed_file.write_text("다이어트\n", encoding="utf-8")

        results = nk.collect(str(seed_file))

        scores = [r["score"] for r in results]
        assert scores == sorted(scores, reverse=True), "점수 내림차순 정렬 실패"

    @patch("naver_keywords.fetch_related_keywords")
    def test_risk_keywords_score_zero(self, mock_fetch, tmp_path):
        mock_fetch.return_value = MOCK_KEYWORD_LIST
        seed_file = tmp_path / "seeds.txt"
        seed_file.write_text("다이어트\n", encoding="utf-8")

        results = nk.collect(str(seed_file))
        risky = [r for r in results if "도박" in r["keyword"]]
        assert all(r["score"] == 0.0 for r in risky)

    @patch("naver_keywords.fetch_related_keywords")
    def test_deduplication(self, mock_fetch, tmp_path):
        mock_fetch.return_value = MOCK_KEYWORD_LIST
        seed_file = tmp_path / "seeds.txt"
        # 같은 시드 두 번 → 중복 제거
        seed_file.write_text("다이어트\n다이어트\n", encoding="utf-8")

        results = nk.collect(str(seed_file))
        keywords = [r["keyword"] for r in results]
        assert len(keywords) == len(set(keywords)), "중복 키워드 존재"


# ── save_csv() 테스트 ─────────────────────────────────────
class TestSaveCsv:
    def test_csv_created(self, tmp_path):
        data = [
            {"keyword": "운동화", "pc_volume": 5000, "mobile_volume": 10000, "competition": "낮음", "score": 5000.0},
            {"keyword": "헬스", "pc_volume": 3000, "mobile_volume": 6000, "competition": "보통", "score": 3000.0},
        ]
        path = nk.save_csv(data, out_dir=tmp_path)
        assert path.exists()

    def test_csv_header_and_rows(self, tmp_path):
        data = [
            {"keyword": "운동화", "pc_volume": 5000, "mobile_volume": 10000, "competition": "낮음", "score": 5000.0},
        ]
        path = nk.save_csv(data, out_dir=tmp_path)
        with open(path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert rows[0]["keyword"] == "운동화"
        assert rows[0]["score"] == "5000.0"

    def test_csv_sorted_order_preserved(self, tmp_path):
        data = [
            {"keyword": "A", "pc_volume": 9000, "mobile_volume": 0, "competition": "낮음", "score": 9000.0},
            {"keyword": "B", "pc_volume": 100, "mobile_volume": 0, "competition": "높음", "score": 100.0},
        ]
        path = nk.save_csv(data, out_dir=tmp_path)
        with open(path, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        assert rows[0]["keyword"] == "A"
        assert rows[1]["keyword"] == "B"


# ── 모의 실행 E2E 테스트 ──────────────────────────────────
class TestEndToEnd:
    @patch("requests.get")
    def test_full_pipeline(self, mock_get, tmp_path):
        mock_get.return_value = _mock_response(MOCK_KEYWORD_LIST)

        seed_file = tmp_path / "seeds.txt"
        seed_file.write_text("다이어트\n헬스\n", encoding="utf-8")

        results = nk.collect(str(seed_file))
        csv_path = nk.save_csv(results, out_dir=tmp_path / "output")

        assert csv_path.exists()
        scores = [r["score"] for r in results]
        assert scores == sorted(scores, reverse=True)
        # 도박 키워드는 score=0
        risky = [r for r in results if "도박" in r["keyword"]]
        assert all(r["score"] == 0.0 for r in risky)
