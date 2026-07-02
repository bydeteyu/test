"""
네이버 검색광고 API — 연관 키워드 + 월간 검색량(PC/모바일) + 경쟁정도 조회

인증 정보는 코드에 넣지 않고 환경변수에서 읽는다:
  NAVER_AD_API_KEY      (X-API-KEY)
  NAVER_AD_SECRET_KEY   (서명용 비밀키)
  NAVER_AD_CUSTOMER_ID  (X-Customer)
"""

import os
import re
import time
import hmac
import base64
import hashlib
import requests

BASE_URL = "https://api.searchad.naver.com"

API_KEY = os.environ.get("NAVER_AD_API_KEY", "").strip()
SECRET_KEY = os.environ.get("NAVER_AD_SECRET_KEY", "").strip()
CUSTOMER_ID = os.environ.get("NAVER_AD_CUSTOMER_ID", "").strip()

# 한 번의 요청에 넣을 수 있는 hintKeywords 개수(네이버 제한: 최대 5개)
HINTS_PER_CALL = 5
REQUEST_DELAY = 0.35  # 호출 간 간격(초) — 레이트리밋 여유


def credentials_ready() -> bool:
    return bool(API_KEY and SECRET_KEY and CUSTOMER_ID)


def make_signature(timestamp, method, uri, secret_key):
    """네이버 검색광고 API 인증 서명 생성"""
    message = f"{timestamp}.{method}.{uri}"
    digest = hmac.new(
        secret_key.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def _to_number(value):
    """검색량이 '< 10' 같은 문자열로 올 때 숫자로 변환."""
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = re.sub(r"[^\d]", "", value)
        if not digits:
            return 0
        # '< 10' 은 실제로 10 미만이므로 대략 5로 처리
        return 5 if value.strip().startswith("<") else int(digits)
    return 0


def get_related_keywords(hint_keywords):
    """hintKeywords(리스트) → keywordList (원본 dict 리스트)"""
    uri = "/keywordstool"
    method = "GET"
    timestamp = str(int(time.time() * 1000))
    signature = make_signature(timestamp, method, uri, SECRET_KEY)

    headers = {
        "X-Timestamp": timestamp,
        "X-API-KEY": API_KEY,
        "X-Customer": CUSTOMER_ID,
        "X-Signature": signature,
    }
    # 네이버는 키워드 내 공백을 허용하지 않음 → 제거
    hint = ",".join(k.replace(" ", "") for k in hint_keywords if k.strip())
    params = {"hintKeywords": hint, "showDetail": 1}

    res = requests.get(BASE_URL + uri, headers=headers, params=params, timeout=15)
    if res.status_code != 200:
        # 네이버가 돌려주는 실제 오류 메시지를 그대로 전달
        raise RuntimeError(f"HTTP {res.status_code}: {res.text[:300]}")
    return res.json().get("keywordList", [])


def run_keywordtool(keywords, progress_cb=None):
    """
    keywords: 시드 키워드 리스트
    progress_cb(done, total): 진행 콜백(선택)
    반환: 검색량 내림차순 정렬된 dict 리스트
          [{keyword, pc, mobile, total, comp}, ...]
    """
    if not credentials_ready():
        raise RuntimeError(
            "검색광고 API 인증정보가 없습니다. Railway 환경변수 "
            "NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID 를 설정하세요."
        )

    seeds = [k.strip() for k in keywords if k.strip()]
    batches = [seeds[i:i + HINTS_PER_CALL] for i in range(0, len(seeds), HINTS_PER_CALL)]
    total = len(seeds)
    done = 0
    rows = {}
    errors = []

    for batch in batches:
        try:
            for item in get_related_keywords(batch):
                kw = item.get("relKeyword", "").strip()
                if not kw:
                    continue
                pc = _to_number(item.get("monthlyPcQcCnt"))
                mobile = _to_number(item.get("monthlyMobileQcCnt"))
                rows[kw] = {
                    "keyword": kw,
                    "pc": pc,
                    "mobile": mobile,
                    "total": pc + mobile,
                    "comp": item.get("compIdx", "-"),
                }
        except Exception as e:
            errors.append(f"{', '.join(batch)}: {e}")
        done += len(batch)
        if progress_cb:
            progress_cb(done, total)
        time.sleep(REQUEST_DELAY)

    result = sorted(rows.values(), key=lambda r: r["total"], reverse=True)
    return result, errors
