"""
네이버 자동완성 기반 파생 키워드 수집기
==========================================
시드 키워드 → 자동완성 API로 연관어를 얻고, 그 연관어들을 다시 시드로
삼아 재귀적으로 확장한다(기본 2단계). 인증이 필요 없는 가벼운 JSON
엔드포인트(ac.search.naver.com)라 Playwright 없이 requests만으로 처리한다.

단계가 깊어질수록 결과가 기하급수적으로 늘고(단계당 최대 10배) 관련성은
급격히 떨어지므로 깊이는 최대 2단계로 제한한다. 병렬 처리는 2개씩
(다른 기능들과 동일하게 안정성 우선), 요청 사이/단계 사이에 짧은 대기를
둬서 비인증 공개 엔드포인트를 과하게 두드리지 않는다.
"""

import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

AC_URL = "https://ac.search.naver.com/nx/ac"

MAX_WORKERS = 2
MIN_DELAY = 0.5     # 요청 하나 끝난 뒤 대기(초, 최소)
MAX_DELAY = 1.2     # 요청 하나 끝난 뒤 대기(초, 최대)
DEPTH_DELAY = 2.0   # 단계 사이 대기
MAX_RETRIES = 2
RETRY_BACKOFF = 2.0
REQUEST_TIMEOUT = 8
MAX_DEPTH_LIMIT = 2  # 이 이상은 노이즈만 늘어서 허용하지 않음

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

# 자동완성에 흔히 섞여나오는 안내 배지/꼬리 문구
_BADGE_RE = re.compile(r"(요즘\s*인기|인기|광고|검색)\s*$")
_URL_RE = re.compile(r"(https?://|www\.|\.com|\.co\.kr|\.kr|\.io|\.net|\.org|/)", re.I)
_NUMERIC_RE = re.compile(r"^[\d,.\s년월일주시간개]+$")
_DATE_RE = re.compile(r"^\d{4}([.\-/]\d{1,2}){0,2}\.?$")
_JUNK_WORDS = ("열기", "더보기", "바로가기", "저장", "가이드", "신고", "도움말")
_SPECIAL_CHARS = set("[]{}◆♥«»【】~|·…“”\"")


def _clean_kw(text: str) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    t = _BADGE_RE.sub("", t).strip()
    t = re.sub(r"\s*(\.\.\.|…)\s*$", "", t).strip()
    return t


def _valid_kw(text: str) -> bool:
    """자동완성 항목처럼 보이는 짧은 검색어만 통과."""
    if not text or not (2 <= len(text) <= 30):
        return False
    if _URL_RE.search(text) or _NUMERIC_RE.match(text) or _DATE_RE.match(text):
        return False
    if any(text.endswith(w) or w in text for w in _JUNK_WORDS):
        return False
    if any(c in _SPECIAL_CHARS for c in text):
        return False
    return True


def fetch_autocomplete(keyword: str) -> list[str]:
    """네이버 자동완성 목록. 일시적 오류는 재시도하고, 최종 실패하면 빈 리스트."""
    params = {
        "q": keyword, "st": 100, "r_format": "json", "r_enc": "UTF-8",
        "r_unicode": 0, "t_koreng": 1, "run": 2, "rev": 4, "q_enc": "UTF-8",
    }
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Referer": "https://www.naver.com/",
        "Accept": "*/*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    }
    for attempt in range(1, MAX_RETRIES + 2):
        try:
            r = requests.get(AC_URL, params=params, headers=headers, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            data = r.json()
            out = []
            for group in data.get("items", []):
                for item in group:
                    if isinstance(item, list) and item:
                        kw = _clean_kw(item[0])
                        if _valid_kw(kw):
                            out.append(kw)
            return out
        except Exception:
            if attempt <= MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
            else:
                return []
    return []


def run_autocomplete(seed_keyword: str, max_depth: int = 2, progress_cb=None) -> list[dict]:
    """
    시드 키워드에서 시작해 max_depth 단계까지 자동완성을 재귀 확장한다.

    반환: [{'keyword', 'depth', 'parent'}, ...] — 시드 자신은 포함하지 않음,
    같은 키워드가 여러 부모에서 나와도 처음 발견된 것 하나만 남는다.

    progress_cb(depth, done, total, collected)가 주어지면 이번 단계에서
    처리한 키워드 수(done/total)와 지금까지 모인 전체 파생 키워드 수를
    처리 하나 끝날 때마다 알려준다.
    """
    seed_keyword = seed_keyword.strip()
    max_depth = max(1, min(max_depth, MAX_DEPTH_LIMIT))

    visited = {seed_keyword}
    found: dict[str, dict] = {}
    current_level = [seed_keyword]

    def _job(kw):
        suggestions = fetch_autocomplete(kw)
        time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        return kw, suggestions

    for depth in range(1, max_depth + 1):
        if not current_level:
            break
        total = len(current_level)
        done = 0
        next_level = []

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(_job, kw): kw for kw in current_level}
            for future in as_completed(futures):
                parent_kw, suggestions = future.result()
                for s in suggestions:
                    if s in visited:
                        continue
                    visited.add(s)
                    found[s] = {"keyword": s, "depth": depth, "parent": parent_kw}
                    next_level.append(s)
                done += 1
                if progress_cb:
                    progress_cb(depth, done, total, len(found))

        current_level = next_level
        if depth < max_depth and current_level:
            time.sleep(DEPTH_DELAY)

    return sorted(found.values(), key=lambda r: (r["depth"], r["keyword"]))
