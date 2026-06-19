"""
Step 4: AI 검색 대응 후처리
상위 키워드를 질문형·롱테일 형태로 자동 변환·확장한다.
"""

_QUESTION_TEMPLATES = [
    "{kw} 추천",
    "{kw} 가격",
    "{kw} 후기",
    "{kw} 비교",
    "{kw} 장단점",
    "{kw}이란 무엇인가",
    "{kw} 사용법",
    "{kw} 종류",
    "가장 좋은 {kw}",
    "{kw} 선택 기준",
]

_LONGTAIL_SUFFIXES = [
    " 추천 2026",
    " 초보자용",
    " 가성비",
    " 무료",
    " 대안",
]


def expand_keywords(
    scored_keywords: list[dict],
    top_n: int = 20,
) -> list[dict]:
    """
    상위 top_n개 키워드를 질문형/롱테일로 확장한다.
    Returns: 원본 행에 expanded_keywords 필드 추가
    """
    results = []
    for row in scored_keywords[:top_n]:
        kw = row["keyword"]
        question_variants = [t.format(kw=kw) for t in _QUESTION_TEMPLATES]
        longtail_variants = [kw + s for s in _LONGTAIL_SUFFIXES]
        results.append(
            {
                **row,
                "question_variants": question_variants,
                "longtail_variants": longtail_variants,
            }
        )
    return results
