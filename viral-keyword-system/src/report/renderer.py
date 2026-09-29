"""
Step 4: Render daily markdown report.
Output: output/YYYY-MM-DD.md
"""

import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

OUTPUT_DIR = Path(__file__).parent.parent.parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

CAFE_NAMES = {
    "dangsamo": "당뇨와건강",
    "pyurion": "고고당",
    "cantsb": "씨씨앙",
    "thyroidcancers": "갑상선포럼",
    "t1d": "슈거트리",
    "rksghwhantk": "전간조",
}

TRACK_KO = {
    "몸의_신호": "몸의 신호",
    "검진_결과": "검진 결과",
    "가족력_효심": "가족력·효심",
    "일상_음식_습관": "일상 음식·습관",
    "생활_패턴": "생활 패턴",
    "약_치료": "약·치료",
    "방송발": "방송발 키워드",
    "미디어_불신": "미디어 불신 반작용",
    "기타": "기타",
}


def _render_top3(top3: list[dict]) -> str:
    if not top3:
        return "_데이터 수집 실패로 TOP 3 생성 불가_\n"

    blocks = []
    for item in top3:
        rank = item.get("rank", "?")
        title = item.get("title", "")
        score = item.get("total_score", "N/A")
        track = TRACK_KO.get(item.get("track", ""), item.get("track", ""))
        triggers = item.get("triggers", [])
        evidence = item.get("data_evidence", "")
        usp = item.get("usp_connection", "")
        cafes = item.get("recommended_cafes", [])
        cafe_names = ", ".join(CAFE_NAMES.get(c, c) for c in cafes)

        trigger_str = " + ".join(t.replace("_", " ") for t in triggers)

        block = f"""### {rank}위 — 제목: "{title}"
- **총점**: {score}점
- **트랙**: {track}
- **트리거**: {trigger_str}
- **데이터 근거**: {evidence}
- **써큐톡스 연결**: {usp}
- **추천 카페**: {cafe_names or "전체"}
"""
        blocks.append(block)

    return "\n".join(blocks)


def _render_series(candidates: list[dict]) -> str:
    if not candidates:
        return "_시리즈 후보 생성 실패_\n"
    lines = []
    for i, c in enumerate(candidates[:7], 1):
        lines.append(f"{i}. \"{c.get('title', '')}\"")
        if c.get("pattern"):
            lines.append(f"   → {c['pattern']}")
    return "\n".join(lines)


def _render_rising_keywords(trends: dict[str, float]) -> str:
    rising = sorted(
        [(k, v) for k, v in trends.items() if v >= 20],
        key=lambda x: -x[1],
    )[:10]
    if not rising:
        return "| - | 데이터 없음 | - |\n"
    rows = []
    for kw, chg in rising:
        source = "데이터랩"
        rows.append(f"| {kw} | {chg:+.0f}% | {source} |")
    return "\n".join(rows)


def _render_cafe_summary(cafe_summary: dict) -> str:
    if not cafe_summary:
        return "_카페 수집 데이터 없음_\n"
    lines = []
    for slug, info in cafe_summary.items():
        name = CAFE_NAMES.get(slug, slug)
        tracks = info.get("tracks", {})
        top_track = max(tracks, key=tracks.get) if tracks else "?"
        top_track_ko = TRACK_KO.get(top_track, top_track)
        sample = info.get("top_titles", [])
        sample_str = f'"{sample[0]}"' if sample else "-"
        lines.append(
            f"- **{name}**: {info.get('count', 0)}건 수집, "
            f"주요 트랙: {top_track_ko}, 샘플: {sample_str}"
        )
    return "\n".join(lines)


def _render_youtube(videos: list[dict]) -> str:
    viral = [v for v in videos if v.get("is_viral")]
    if not viral:
        return "_유튜브 데이터 없음 (YOUTUBE_API_KEY 미설정)_\n"
    lines = []
    for v in viral[:5]:
        lines.append(
            f"- **{v['channel']}** 신규 영상: \"{v['title']}\" "
            f"— 조회수 {v['views']:,} (채널 평균 +50% 이상)"
        )
    return "\n".join(lines)


def render_report(
    generated: dict,
    analysis: dict,
    trends: dict[str, float],
    videos: list[dict],
    seasonal_signals: list[str],
    date: datetime,
) -> Path:
    """Render and save the daily markdown report. Returns output file path."""

    date_str = date.strftime("%Y-%m-%d")
    generated_at = date.strftime("%Y-%m-%d %H:%M:%S")

    seasonal_block = "\n".join(f"- {s}" for s in seasonal_signals) or "- 특이 시즌 없음"
    top3_block = _render_top3(generated.get("top3", []))
    series_block = _render_series(generated.get("series_candidates", []))
    rising_block = _render_rising_keywords(trends)
    cafe_block = _render_cafe_summary(analysis.get("cafe_summary", {}))
    yt_block = _render_youtube(videos)
    memo = generated.get("analysis_memo", "")

    # Warning block
    warnings = []
    if not trends:
        warnings.append("- NAVER_CLIENT_ID/SECRET 미설정 → 데이터랩 급상승 집계 없음")
    if not videos:
        warnings.append("- YOUTUBE_API_KEY 미설정 → 방송발 트렌드 없음")
    if not analysis.get("total_posts"):
        warnings.append("- 카페 수집 데이터 없음 → 네트워크 또는 차단 여부 확인 필요")
    warning_block = "\n".join(warnings) if warnings else ""

    report = f"""# 🌅 황금 키워드 일일 리포트 — {date_str}

## 📅 오늘의 시즌 신호
{seasonal_block}

---

## 🏆 황금 제목 TOP 3

{top3_block}
---

## 🎯 시리즈화 후보

{series_block}

---

## 🔥 오늘의 급상승 키워드

| 키워드 | 검색량 변화 | 출처 |
|---|---|---|
{rising_block}

---

## 📊 카페별 페인 요약 (최근 7일)

{cafe_block}

---

## 💊 방송발 트렌드

{yt_block}

---

## 📝 오늘의 트렌드 메모

{memo or "메모 없음"}

"""

    if warning_block:
        report += f"""## ⚠️ 주의 / 데이터 품질

{warning_block}

---

"""

    report += f"""---

생성 시각: {generated_at}
수집 게시글: {analysis.get("total_posts", 0)}건
시스템 버전: v0.1
"""

    output_path = OUTPUT_DIR / f"{date_str}.md"
    output_path.write_text(report, encoding="utf-8")
    logger.info("리포트 저장 완료: %s", output_path)
    return output_path
