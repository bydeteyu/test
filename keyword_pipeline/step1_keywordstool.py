"""
Step 1: 네이버 검색광고 KeywordsTool API
연관 키워드, 월간 검색량, 경쟁도 수집
"""

import os
import hmac
import hashlib
import base64
import time
import requests
from typing import Optional


def _make_signature(timestamp: str, method: str, path: str, secret_key: str) -> str:
    message = f"{timestamp}.{method}.{path}"
    signature = hmac.new(
        secret_key.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(signature).decode("utf-8")


def fetch_related_keywords(
    seed_keyword: str,
    api_key: Optional[str] = None,
    secret_key: Optional[str] = None,
    customer_id: Optional[str] = None,
) -> list[dict]:
    """
    시드 키워드로 연관 키워드 + 검색량 + 경쟁도를 가져온다.
    Returns list of dicts with keys:
      relKeyword, monthlyPcQcCnt, monthlyMobileQcCnt, compIdx, plAvgDepth
    """
    api_key = api_key or os.environ["NAVER_AD_API_KEY"]
    secret_key = secret_key or os.environ["NAVER_AD_SECRET_KEY"]
    customer_id = customer_id or os.environ["NAVER_AD_CUSTOMER_ID"]

    path = "/keywordstool"
    method = "GET"
    timestamp = str(int(time.time() * 1000))
    signature = _make_signature(timestamp, method, path, secret_key)

    headers = {
        "X-Timestamp": timestamp,
        "X-API-KEY": api_key,
        "X-Customer": customer_id,
        "X-Signature": signature,
    }
    params = {
        "hintKeywords": seed_keyword,
        "showDetail": "1",
    }

    url = "https://api.naver.com" + path
    resp = requests.get(url, headers=headers, params=params, timeout=10)
    resp.raise_for_status()

    data = resp.json()
    keywords = data.get("keywordList", [])

    results = []
    for kw in keywords:
        pc = kw.get("monthlyPcQcCnt", 0)
        mobile = kw.get("monthlyMobileQcCnt", 0)

        # "<10" 등의 문자열 처리
        pc = 5 if pc == "< 10" else int(pc)
        mobile = 5 if mobile == "< 10" else int(mobile)

        results.append(
            {
                "keyword": kw.get("relKeyword", ""),
                "monthly_pc": pc,
                "monthly_mobile": mobile,
                "monthly_total": pc + mobile,
                "comp_idx": kw.get("compIdx", ""),      # "높음" / "중간" / "낮음"
                "pl_avg_depth": kw.get("plAvgDepth", 0),
            }
        )

    return results
