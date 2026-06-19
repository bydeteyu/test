"""
Step 2: 네이버 데이터랩 트렌드 API
키워드별 최근 12개월 검색 트렌드 지수를 가져와 추세를 분류한다.
"""

import os
import json
import time
from datetime import date, timedelta
import requests


_DATALAB_URL = "https://openapi.naver.com/v1/datalab/search"
_MAX_KEYWORDS_PER_REQUEST = 5  # API 제한


def _trend_slope(ratios: list[float]) -> float:
    """단순 선형 기울기 (마지막 3개월 평균 vs 처음 3개월 평균)"""
    if len(ratios) < 6:
        return 0.0
    early = sum(ratios[:3]) / 3
    late = sum(ratios[-3:]) / 3
    return (late - early) / max(early, 1)


def _classify_trend(ratios: list[float]) -> str:
    slope = _trend_slope(ratios)
    if slope > 0.15:
        return "상승"
    if slope < -0.15:
        return "하락"
    # 계절성: 표준편차가 높으면 계절성으로 판단
    mean = sum(ratios) / len(ratios) if ratios else 0
    variance = sum((r - mean) ** 2 for r in ratios) / len(ratios) if ratios else 0
    std = variance ** 0.5
    if std / max(mean, 1) > 0.3:
        return "계절성"
    return "안정"


def fetch_trends(
    keywords: list[str],
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict[str, dict]:
    """
    키워드 리스트를 받아 각 키워드의 트렌드 정보를 반환한다.
    Returns: {keyword: {"trend_label": str, "ratios": list[float]}}
    """
    client_id = client_id or os.environ["NAVER_DATALAB_CLIENT_ID"]
    client_secret = client_secret or os.environ["NAVER_DATALAB_CLIENT_SECRET"]

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
        "Content-Type": "application/json",
    }

    end_date = date.today().replace(day=1) - timedelta(days=1)
    start_date = (end_date.replace(day=1) - timedelta(days=365)).replace(day=1)

    results: dict[str, dict] = {}

    # 5개씩 배치 요청
    for i in range(0, len(keywords), _MAX_KEYWORDS_PER_REQUEST):
        batch = keywords[i : i + _MAX_KEYWORDS_PER_REQUEST]
        keyword_groups = [
            {"groupName": kw, "keywords": [kw]} for kw in batch
        ]
        body = {
            "startDate": start_date.strftime("%Y-%m-%d"),
            "endDate": end_date.strftime("%Y-%m-%d"),
            "timeUnit": "month",
            "keywordGroups": keyword_groups,
        }

        resp = requests.post(
            _DATALAB_URL,
            headers=headers,
            data=json.dumps(body),
            timeout=15,
        )
        resp.raise_for_status()

        for item in resp.json().get("results", []):
            kw_name = item["title"]
            ratios = [p["ratio"] for p in item.get("data", [])]
            results[kw_name] = {
                "trend_label": _classify_trend(ratios),
                "ratios": ratios,
            }

        if i + _MAX_KEYWORDS_PER_REQUEST < len(keywords):
            time.sleep(0.5)  # API rate limit 방지

    return results
