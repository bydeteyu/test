"""
네이버 자동완성 + 함께 많이 찾는 키워드 크롤러
"""

import re
import time
import random
import requests
from urllib.parse import quote
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed

MAX_WORKERS = 5
MIN_DELAY = 1.0
MAX_DELAY = 2.0
DEPTH_DELAY = 5.0
MAX_RETRIES = 3
RETRY_BACKOFF = 3.0
REQUEST_TIMEOUT = 10

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) "
    "Gecko/20100101 Firefox/121.0",
]

SEARCH_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}


def _headers(referer=None):
    h = dict(SEARCH_HEADERS)
    h["User-Agent"] = random.choice(USER_AGENTS)
    if referer:
        h["Referer"] = referer
    return h


def get_naver_autocomplete(keyword, retry_count=0):
    """네이버 자동완성 API → 추천 키워드 리스트"""
    url = "https://ac.search.naver.com/nx/ac"
    params = {
        "q": keyword, "st": 100, "r_format": "json",
        "r_enc": "UTF-8", "r_unicode": 0, "t_koreng": 1,
        "run": 2, "rev": 4, "q_enc": "UTF-8",
    }
    try:
        r = requests.get(url, params=params,
                         headers=_headers("https://www.naver.com/"),
                         timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        suggestions = []
        if "items" in data and data["items"]:
            for group in data["items"]:
                for item in group:
                    if isinstance(item, list) and item:
                        suggestions.append(item[0])
        time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        return suggestions

    except requests.exceptions.Timeout:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return []
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response else 0
        if status == 429:
            time.sleep(30)
            if retry_count < MAX_RETRIES:
                return get_naver_autocomplete(keyword, retry_count + 1)
        elif retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return []
    except Exception:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return []


def get_naver_related(keyword, retry_count=0):
    """
    네이버 검색 결과 페이지에서 '함께 많이 찾는' 키워드 스크랩.
    JavaScript 렌더링 없이 requests로 가져옴.
    """
    search_url = f"https://search.naver.com/search.naver?query={quote(keyword)}"
    try:
        r = requests.get(search_url,
                         headers=_headers("https://www.naver.com/"),
                         timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        keywords = []

        # 셀렉터 우선순위 순으로 시도
        selectors = [
            # 2024~2025년 구조
            "div.related_srch a.tit",
            "div.related_srch span.tit",
            "ul.related_srch li a",
            # 함께 많이 찾는 박스 (newer)
            "div[class*='related'] a[class*='keyword']",
            "div[class*='related'] a[class*='tit']",
            # 일반 연관검색어
            "div.keyword_relate a",
            "div.relate_srch a",
            # 데이터 속성 기반
        ]
        for sel in selectors:
            items = soup.select(sel)
            if items:
                for el in items:
                    txt = re.sub(r"\s+", " ", el.get_text()).strip()
                    if txt and 2 <= len(txt) <= 50:
                        keywords.append(txt)
                break

        # 위 셀렉터 모두 실패 시 — 텍스트 패턴으로 부모 탐색
        if not keywords:
            for tag in soup.find_all(string=re.compile("함께 많이 찾는")):
                container = tag.find_parent()
                for _ in range(5):
                    if container is None:
                        break
                    container = container.find_parent()
                    links = container.find_all("a") if container else []
                    if len(links) >= 2:
                        for a in links:
                            txt = re.sub(r"\s+", " ", a.get_text()).strip()
                            if txt and 2 <= len(txt) <= 50:
                                keywords.append(txt)
                        if keywords:
                            break

        time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        return list(dict.fromkeys(keywords))  # 중복 제거, 순서 유지

    except requests.exceptions.Timeout:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_related(keyword, retry_count + 1)
        return []
    except Exception:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_related(keyword, retry_count + 1)
        return []


def fetch_all_for_keyword(keyword):
    """자동완성 + 함께 많이 찾는 합산"""
    ac = get_naver_autocomplete(keyword)
    related = get_naver_related(keyword)
    combined = list(dict.fromkeys(ac + related))
    return keyword, combined, {"autocomplete": len(ac), "related": len(related)}


def run_autocomplete(seed_keyword, max_depth=2, progress_cb=None):
    """
    progress_cb(done, total, depth, last_kw) — 선택적 콜백
    반환: sorted list of keyword strings
    """
    visited = set()
    all_keywords = set()
    current_level = {seed_keyword}

    for depth in range(max_depth):
        if not current_level:
            break
        targets = [kw for kw in current_level if kw not in visited]
        visited.update(targets)
        if not targets:
            continue

        next_level = set()
        completed = 0
        total = len(targets)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(fetch_all_for_keyword, kw): kw for kw in targets}
            for fut in as_completed(futures):
                keyword, suggestions, _ = fut.result()
                completed += 1
                for s in suggestions:
                    all_keywords.add(s)
                    if s not in visited:
                        next_level.add(s)
                if progress_cb:
                    progress_cb(completed, total, depth, keyword)

        current_level = next_level
        if depth < max_depth - 1 and next_level:
            time.sleep(DEPTH_DELAY)

    return sorted(all_keywords)
