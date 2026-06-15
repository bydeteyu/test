"""
Step 2: Analyze collected posts for keyword frequency, pain tracks, and scoring.
"""

import re
import logging
from collections import Counter
from datetime import datetime

logger = logging.getLogger(__name__)

CONTENT_TRACKS = {
    "몸의_신호": [
        "저림", "부종", "어지러움", "두통", "피로", "무기력", "손발", "차가움",
        "저리", "붓기", "눈침침", "이명",
    ],
    "검진_결과": [
        "검진", "수치", "결과", "LDL", "콜레스테롤", "혈당", "공복혈당",
        "중성지방", "혈압", "경계", "높음", "정상범위",
    ],
    "가족력_효심": [
        "부모님", "어머니", "아버지", "부모", "가족력", "효도", "선물",
        "엄마", "아빠", "할머니", "할아버지",
    ],
    "일상_음식_습관": [
        "음식", "식단", "먹으면", "드시면", "먹는것", "음료", "커피",
        "술", "탄수화물", "당분", "밀가루", "과자",
    ],
    "생활_패턴": [
        "수면", "스트레스", "운동", "계절", "날씨", "폭염", "한파",
        "명절", "야근", "피로", "패턴",
    ],
    "약_치료": [
        "약", "복용", "끊기", "병용", "처방", "부작용", "스타틴",
        "메트포민", "혈압약", "당뇨약", "영양제",
    ],
    "방송발": [
        "방송", "뉴스", "유튜브", "닥터", "의사", "약사", "한의사",
        "교수", "전문가", "추천", "티어",
    ],
    "미디어_불신": [
        "진짜", "사기", "거짓", "속았", "불신", "부작용", "논란",
        "검증", "실험", "효과없", "효과 없",
    ],
}

NUMBER_PATTERNS = [
    r"\d{2,3}\/\d{2,3}",   # 138/89
    r"공복혈당\s*\d+",
    r"혈당\s*\d+",
    r"콜레스테롤\s*\d+",
    r"LDL\s*\d+",
    r"중성지방\s*\d+",
    r"혈압\s*\d+",
]


def _extract_keywords(text: str) -> list[str]:
    """Extract meaningful Korean keyword tokens from text (2+ chars)."""
    # Remove special chars but keep Korean, numbers, letters
    cleaned = re.sub(r"[^\w\s가-힣]", " ", text)
    tokens = cleaned.split()
    return [t for t in tokens if len(t) >= 2]


def _classify_track(title: str) -> str:
    """Return the best-matching content track for a title."""
    scores = {}
    title_lower = title.lower()
    for track, kws in CONTENT_TRACKS.items():
        score = sum(1 for kw in kws if kw in title_lower)
        if score > 0:
            scores[track] = score
    if not scores:
        return "기타"
    return max(scores, key=scores.get)


def _extract_numbers(title: str) -> list[str]:
    """Extract specific health numbers from title."""
    found = []
    for pat in NUMBER_PATTERNS:
        matches = re.findall(pat, title, re.IGNORECASE)
        found.extend(matches)
    return found


def analyze_cafe_posts(posts: list[dict]) -> dict:
    """
    Analyze collected cafe posts.
    Returns structured analysis result.
    """
    if not posts:
        logger.warning("분석할 카페 게시글이 없음")
        return {"top_keywords": [], "track_distribution": {}, "pain_posts": []}

    # 1. Frequency count across all titles
    all_tokens = []
    for post in posts:
        all_tokens.extend(_extract_keywords(post.get("title", "")))

    keyword_freq = Counter(all_tokens)

    # Filter noise: single-char, common stop words
    stop_words = {"이", "가", "을", "를", "은", "는", "의", "에", "도", "고",
                  "어", "서", "로", "으로", "와", "과", "이다", "있다", "하다",
                  "그", "저", "제", "저는", "저도", "합니다", "입니다", "있어요"}
    top_keywords = [
        {"keyword": kw, "count": cnt}
        for kw, cnt in keyword_freq.most_common(100)
        if kw not in stop_words and len(kw) >= 2
    ][:50]

    # 2. Track classification
    track_posts: dict[str, list] = {track: [] for track in CONTENT_TRACKS}
    track_posts["기타"] = []

    for post in posts:
        track = _classify_track(post.get("title", ""))
        track_posts.setdefault(track, []).append(post)

    track_distribution = {
        track: len(plist) for track, plist in track_posts.items() if plist
    }

    # 3. High-signal pain posts (have numbers + emotion words)
    emotion_words = ["진짜", "정말", "너무", "무서워", "어떡", "미치겠", "어지러", "ㅠ", ";;", "…"]
    pain_posts = []
    for post in posts:
        title = post.get("title", "")
        has_number = bool(_extract_numbers(title))
        has_emotion = any(ew in title for ew in emotion_words)
        if has_number or has_emotion:
            pain_posts.append(
                {**post, "numbers": _extract_numbers(title), "track": _classify_track(title)}
            )

    # 4. Per-cafe summary
    cafe_summary: dict[str, dict] = {}
    for post in posts:
        cafe = post.get("cafe", "unknown")
        if cafe not in cafe_summary:
            cafe_summary[cafe] = {"count": 0, "tracks": Counter(), "top_titles": []}
        cafe_summary[cafe]["count"] += 1
        cafe_summary[cafe]["tracks"][_classify_track(post.get("title", ""))] += 1
        if len(cafe_summary[cafe]["top_titles"]) < 5:
            cafe_summary[cafe]["top_titles"].append(post.get("title", ""))

    logger.info(
        "분석 완료: 빈출키워드 %d개, 페인 게시글 %d개, 트랙 분포 %s",
        len(top_keywords), len(pain_posts), track_distribution,
    )

    return {
        "top_keywords": top_keywords,
        "track_distribution": track_distribution,
        "pain_posts": pain_posts[:30],
        "cafe_summary": cafe_summary,
        "total_posts": len(posts),
    }
