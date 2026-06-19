"""
출력: CSV 저장 및 콘솔 대시보드
"""

import csv
import os
from datetime import datetime


def save_csv(expanded: list[dict], output_dir: str = "output") -> str:
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(output_dir, f"keywords_{timestamp}.csv")

    if not expanded:
        return path

    fieldnames = [
        "keyword",
        "monthly_pc",
        "monthly_mobile",
        "monthly_total",
        "comp_idx",
        "trend_label",
        "opportunity_score",
        "question_variants",
        "longtail_variants",
    ]

    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in expanded:
            writer.writerow(
                {
                    **row,
                    "question_variants": " | ".join(row.get("question_variants", [])),
                    "longtail_variants": " | ".join(row.get("longtail_variants", [])),
                }
            )

    return path


def print_dashboard(expanded: list[dict], top_n: int = 10) -> None:
    print("\n" + "=" * 72)
    print(f"{'기회 키워드 TOP ' + str(top_n):^72}")
    print("=" * 72)
    header = f"{'#':>3}  {'키워드':<20} {'검색량':>8} {'경쟁도':>6} {'트렌드':>6} {'점수':>7}"
    print(header)
    print("-" * 72)
    for i, row in enumerate(expanded[:top_n], 1):
        print(
            f"{i:>3}  {row['keyword']:<20} {row['monthly_total']:>8,}"
            f"  {row.get('comp_idx', ''):>6}  {row.get('trend_label', ''):>6}"
            f"  {row['opportunity_score']:>7.2f}"
        )
    print("=" * 72)

    if expanded:
        print("\n[질문형/롱테일 확장 예시 - 1위 키워드]")
        top = expanded[0]
        print("  질문형:", " / ".join(top.get("question_variants", [])[:3]))
        print("  롱테일: ", " / ".join(top.get("longtail_variants", [])[:3]))
    print()
