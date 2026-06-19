#!/usr/bin/env python3
"""
네이버 키워드 기회 분석 파이프라인
사용법: python main.py <시드 키워드> [시드 키워드2 ...]
"""

import sys
from dotenv import load_dotenv

from keyword_pipeline.step1_keywordstool import fetch_related_keywords
from keyword_pipeline.step2_datalab import fetch_trends
from keyword_pipeline.step3_scoring import score_keywords
from keyword_pipeline.step4_ai_expansion import expand_keywords
from keyword_pipeline.output import save_csv, print_dashboard


def run(seed_keywords: list[str]) -> None:
    load_dotenv()

    print(f"[1/4] 연관 키워드 수집 중... (시드: {', '.join(seed_keywords)})")
    all_keywords: list[dict] = []
    for seed in seed_keywords:
        all_keywords.extend(fetch_related_keywords(seed))

    # 중복 제거
    seen: set[str] = set()
    unique_keywords = []
    for kw in all_keywords:
        if kw["keyword"] not in seen:
            seen.add(kw["keyword"])
            unique_keywords.append(kw)

    print(f"    → {len(unique_keywords)}개 키워드 수집 완료")

    print("[2/4] 트렌드 데이터 수집 중...")
    kw_names = [k["keyword"] for k in unique_keywords]
    trend_data = fetch_trends(kw_names)
    print(f"    → {len(trend_data)}개 트렌드 수집 완료")

    print("[3/4] 기회 점수 계산 중...")
    scored = score_keywords(unique_keywords, trend_data)

    print("[4/4] AI 검색 대응 키워드 확장 중...")
    expanded = expand_keywords(scored, top_n=20)

    print_dashboard(expanded)

    csv_path = save_csv(expanded)
    print(f"CSV 저장 완료: {csv_path}")


if __name__ == "__main__":
    seeds = sys.argv[1:] if len(sys.argv) > 1 else ["파이썬"]
    run(seeds)
