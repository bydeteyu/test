"""
Step 3: 기회 키워드 점수화 및 랭킹
점수 = (검색량 점수) × (경쟁도 역점수) × (트렌드 가중치)
"""

import math

# 경쟁도 역점수
_COMP_SCORE = {"낮음": 3.0, "중간": 1.5, "높음": 0.5, "": 1.0}

# 트렌드 가중치
_TREND_WEIGHT = {"상승": 1.4, "안정": 1.0, "계절성": 1.1, "하락": 0.6}


def _volume_score(total: int) -> float:
    """log 스케일 검색량 점수 (0~100)"""
    if total <= 0:
        return 0.0
    return min(math.log10(total + 1) / math.log10(1_000_001) * 100, 100)


def score_keywords(
    keyword_data: list[dict],
    trend_data: dict[str, dict],
) -> list[dict]:
    """
    keyword_data: step1 결과 리스트
    trend_data:   step2 결과 dict
    Returns: 점수 포함 리스트, 내림차순 정렬
    """
    scored = []
    for row in keyword_data:
        kw = row["keyword"]
        vol_score = _volume_score(row["monthly_total"])
        comp_score = _COMP_SCORE.get(row.get("comp_idx", ""), 1.0)
        trend_info = trend_data.get(kw, {})
        trend_label = trend_info.get("trend_label", "안정")
        trend_w = _TREND_WEIGHT.get(trend_label, 1.0)

        opportunity_score = round(vol_score * comp_score * trend_w, 2)

        scored.append(
            {
                **row,
                "trend_label": trend_label,
                "opportunity_score": opportunity_score,
            }
        )

    scored.sort(key=lambda x: x["opportunity_score"], reverse=True)
    return scored
