"""
네이버 자동완성 키워드 크롤러
"""

import time
import random
import requests
from threading import Lock
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


def get_naver_autocomplete(keyword, retry_count=0):
    url = "https://ac.search.naver.com/nx/ac"
    params = {
        "q": keyword,
        "st": 100,
        "r_format": "json",
        "r_enc": "UTF-8",
        "r_unicode": 0,
        "t_koreng": 1,
        "run": 2,
        "rev": 4,
        "q_enc": "UTF-8",
    }
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Referer": "https://www.naver.com/",
        "Accept": "*/*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        suggestions = []
        if "items" in data and data["items"]:
            for group in data["items"]:
                for item in group:
                    if isinstance(item, list) and item:
                        suggestions.append(item[0])
        time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        return keyword, suggestions

    except requests.exceptions.Timeout:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return keyword, []

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response else 0
        if status == 429:
            time.sleep(30)
            if retry_count < MAX_RETRIES:
                return get_naver_autocomplete(keyword, retry_count + 1)
        elif retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return keyword, []

    except Exception:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return keyword, []


def run_autocomplete(seed_keyword, max_depth=2, progress_cb=None):
    """
    progress_cb(done, total, depth, message) — 선택적 콜백
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
            futures = {pool.submit(get_naver_autocomplete, kw): kw for kw in targets}
            for fut in as_completed(futures):
                keyword, suggestions = fut.result()
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
