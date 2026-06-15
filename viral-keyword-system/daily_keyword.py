#!/usr/bin/env python3
"""
써큐톡스 황금 키워드 일일 발굴 시스템
실행: python daily_keyword.py [--date YYYY-MM-DD] [--skip-collect]
"""

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

# Ensure src is importable
sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv()

from src.collect.naver_cafe import collect_all_cafes
from src.collect.datalab import collect_search_trends
from src.collect.youtube import collect_youtube_trends
from src.analyze.keywords import analyze_cafe_posts
from src.analyze.scorer import load_seasonal_signals
from src.generate.titles import generate_golden_titles
from src.report.renderer import render_report

CONFIG_DIR = Path(__file__).parent / "config"
CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)


def setup_logging(verbose: bool = False):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def load_config() -> tuple[dict, list[dict], list[dict]]:
    seeds = json.loads((CONFIG_DIR / "seeds.json").read_text(encoding="utf-8"))
    cafes = json.loads((CONFIG_DIR / "cafes.json").read_text(encoding="utf-8"))["cafes"]
    channels = json.loads((CONFIG_DIR / "channels.json").read_text(encoding="utf-8"))["youtube_channels"]
    return seeds, cafes, channels


def _cache_path(date: datetime) -> Path:
    return CACHE_DIR / f"{date.strftime('%Y-%m-%d')}_raw.json"


def _save_cache(date: datetime, data: dict):
    _cache_path(date).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_cache(date: datetime) -> dict | None:
    path = _cache_path(date)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def main():
    parser = argparse.ArgumentParser(description="써큐톡스 황금 키워드 일일 발굴")
    parser.add_argument("--date", default=None, help="날짜 (YYYY-MM-DD). 기본값: 오늘")
    parser.add_argument("--skip-collect", action="store_true", help="캐시된 수집 데이터 재사용")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    setup_logging(args.verbose)
    logger = logging.getLogger("main")

    target_date = datetime.strptime(args.date, "%Y-%m-%d") if args.date else datetime.today()
    logger.info("=== 써큐톡스 황금 키워드 발굴 시작: %s ===", target_date.strftime("%Y-%m-%d"))

    # Load configs
    seeds_config, cafes, channels = load_config()
    seed_keywords = seeds_config["seed_keywords"]

    # ── Step 1. Collect ──────────────────────────────────────────────
    cached = _load_cache(target_date) if args.skip_collect else None

    if cached:
        logger.info("캐시 데이터 사용: %s", _cache_path(target_date))
        cafe_posts = cached.get("cafe_posts", [])
        trends = cached.get("trends", {})
        videos = cached.get("videos", [])
    else:
        logger.info("── Step 1. 수집 시작 ──")

        logger.info("[소스 A] 네이버 카페 수집...")
        try:
            cafe_posts = collect_all_cafes(seed_keywords, cafes)
        except Exception as e:
            logger.error("카페 수집 전체 실패: %s", e)
            cafe_posts = []

        logger.info("[소스 B] 네이버 데이터랩 수집...")
        try:
            trends = collect_search_trends(seed_keywords)
        except Exception as e:
            logger.error("데이터랩 수집 실패: %s", e)
            trends = {}

        logger.info("[소스 C] 유튜브 수집...")
        try:
            videos = collect_youtube_trends(channels)
        except Exception as e:
            logger.error("유튜브 수집 실패: %s", e)
            videos = []

        _save_cache(target_date, {
            "cafe_posts": cafe_posts,
            "trends": trends,
            "videos": videos,
        })
        logger.info("수집 완료 → 카페 %d건, 트렌드 %d개, 영상 %d개",
                    len(cafe_posts), len(trends), len(videos))

    # ── Step 2. Analyze ──────────────────────────────────────────────
    logger.info("── Step 2. 분석 시작 ──")
    analysis = analyze_cafe_posts(cafe_posts)
    seasonal_signals = load_seasonal_signals(target_date.month)
    logger.info("시즌 신호: %s", seasonal_signals)

    # ── Step 3. Generate ─────────────────────────────────────────────
    logger.info("── Step 3. 제목 생성 (Claude API) ──")
    generated = generate_golden_titles(analysis, trends, videos, seasonal_signals)

    # ── Step 4. Report ───────────────────────────────────────────────
    logger.info("── Step 4. 리포트 생성 ──")
    output_path = render_report(generated, analysis, trends, videos, seasonal_signals, target_date)

    logger.info("")
    logger.info("✅ 완료! 리포트 저장: %s", output_path.resolve())
    logger.info("")

    # Print TOP 3 preview
    for item in generated.get("top3", []):
        logger.info("  %s위: %s", item.get("rank"), item.get("title"))

    return str(output_path)


if __name__ == "__main__":
    main()
