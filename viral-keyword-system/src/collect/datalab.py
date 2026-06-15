"""
Naver DataLab Search Trend API.
Docs: https://developers.naver.com/docs/serviceapi/datalab/search/v1/
Requires NAVER_CLIENT_ID and NAVER_CLIENT_SECRET in env.
"""

import os
import json
import logging
from datetime import datetime, timedelta
import requests

logger = logging.getLogger(__name__)

DATALAB_URL = "https://openapi.naver.com/v1/datalab/search"


def _build_payload(keywords: list[str], start_date: str, end_date: str) -> dict:
    """Build DataLab API request payload. Max 5 keyword groups per call."""
    groups = []
    for kw in keywords[:5]:
        groups.append({"groupName": kw, "keywords": [kw]})
    return {
        "startDate": start_date,
        "endDate": end_date,
        "timeUnit": "date",
        "keywordGroups": groups,
    }


def _fetch_trends(
    keywords: list[str], client_id: str, client_secret: str
) -> list[dict]:
    """Call DataLab API for up to 5 keywords at once."""
    today = datetime.today()
    end = today.strftime("%Y-%m-%d")
    start = (today - timedelta(days=30)).strftime("%Y-%m-%d")

    payload = _build_payload(keywords, start, end)
    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
        "Content-Type": "application/json",
    }

    resp = requests.post(DATALAB_URL, headers=headers, data=json.dumps(payload), timeout=15)
    resp.raise_for_status()
    return resp.json().get("results", [])


def _calc_trend_change(results: list[dict]) -> dict[str, float]:
    """
    Calculate % change: last 7 days avg vs prior 7 days avg.
    Returns {keyword: change_pct}.
    """
    changes = {}
    for item in results:
        kw = item["title"]
        data = item.get("data", [])
        if len(data) < 14:
            changes[kw] = 0.0
            continue

        recent = [d["ratio"] for d in data[-7:]]
        prior = [d["ratio"] for d in data[-14:-7]]

        avg_recent = sum(recent) / len(recent) if recent else 0
        avg_prior = sum(prior) / len(prior) if prior else 0

        if avg_prior == 0:
            change = 100.0 if avg_recent > 0 else 0.0
        else:
            change = ((avg_recent - avg_prior) / avg_prior) * 100

        changes[kw] = round(change, 1)

    return changes


def collect_search_trends(seed_keywords: list[str]) -> dict[str, float]:
    """
    Fetch search volume trends for all seed keywords.
    Returns {keyword: change_pct}. Returns empty dict if API unavailable.
    """
    client_id = os.getenv("NAVER_CLIENT_ID", "")
    client_secret = os.getenv("NAVER_CLIENT_SECRET", "")

    if not client_id or not client_secret:
        logger.warning("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정 → 데이터랩 건너뜀")
        return {}

    all_changes: dict[str, float] = {}

    # DataLab allows max 5 keyword groups per request
    for i in range(0, len(seed_keywords), 5):
        chunk = seed_keywords[i : i + 5]
        try:
            results = _fetch_trends(chunk, client_id, client_secret)
            changes = _calc_trend_change(results)
            all_changes.update(changes)
        except requests.RequestException as e:
            logger.warning("데이터랩 API 실패 [chunk %d]: %s", i // 5, e)

    rising = {k: v for k, v in all_changes.items() if v >= 30}
    logger.info(
        "데이터랩 수집 완료: 총 %d개, 급상승(%%) +30 이상 %d개",
        len(all_changes),
        len(rising),
    )
    return all_changes
