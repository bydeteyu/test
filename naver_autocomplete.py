"""
네이버 자동완성 + 함께 많이 찾는 / 연관검색어 키워드 크롤러

- 자동완성: ac.search.naver.com API (가벼움, requests)
- 함께 많이 찾는 / 연관검색어: JavaScript 렌더링이 필요 → Playwright로 페이지를 띄워 스크랩
"""

import re
import time
import random
import requests
from urllib.parse import quote
from bs4 import BeautifulSoup

# Playwright(브라우저)는 메모리를 많이 써서 동시 실행 수를 낮게 잡는다.
MAX_WORKERS = 2
MIN_DELAY = 0.8
MAX_DELAY = 1.6
DEPTH_DELAY = 4.0
MAX_RETRIES = 2
RETRY_BACKOFF = 3.0
REQUEST_TIMEOUT = 10

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

LOW_MEM_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--disable-extensions", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI", "--js-flags=--max-old-space-size=512",
]

# 키워드 정제: 끝에 붙는 안내 배지/아이콘 텍스트 제거
_BADGE_RE = re.compile(r"(요즘\s*인기|인기|광고|검색)\s*$")


def _clean_kw(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    t = _BADGE_RE.sub("", t).strip()
    return t


def _valid_kw(text: str) -> bool:
    return bool(text) and 2 <= len(text) <= 50


# ───────────────────────── 자동완성 (API) ─────────────────────────
def get_naver_autocomplete(keyword, retry_count=0):
    url = "https://ac.search.naver.com/nx/ac"
    params = {
        "q": keyword, "st": 100, "r_format": "json",
        "r_enc": "UTF-8", "r_unicode": 0, "t_koreng": 1,
        "run": 2, "rev": 4, "q_enc": "UTF-8",
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
        out = []
        if data.get("items"):
            for group in data["items"]:
                for item in group:
                    if isinstance(item, list) and item:
                        kw = _clean_kw(item[0])
                        if _valid_kw(kw):
                            out.append(kw)
        return out
    except Exception:
        if retry_count < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF * (retry_count + 1))
            return get_naver_autocomplete(keyword, retry_count + 1)
        return []


# ─────────────── 함께 많이 찾는 / 연관검색어 (Playwright) ───────────────
def extract_related_from_html(html: str) -> list[str]:
    """렌더된 검색결과 HTML에서 '함께 많이 찾는' + '연관 검색어' 키워드 추출."""
    soup = BeautifulSoup(html, "html.parser")
    found = []

    # 1) 헤딩 텍스트 기반 박스 탐색 ('함께 많이 찾는', '연관 검색어')
    heading_pat = re.compile(r"(함께\s*많이\s*찾는|연관\s*검색어)")
    for node in soup.find_all(string=heading_pat):
        # 헤딩에서 위로 올라가며 링크가 여러 개 있는 컨테이너를 찾는다
        container = node.parent
        for _ in range(6):
            if container is None:
                break
            links = container.find_all("a")
            if len(links) >= 2:
                for a in links:
                    kw = _clean_kw(a.get_text())
                    if _valid_kw(kw):
                        found.append(kw)
                break
            container = container.parent

    # 2) 클래스 기반 보조 셀렉터 (네이버 구조 변경 대비)
    if not found:
        for sel in [
            "div.related_srch a", "ul.related_srch a",
            "div.keyword_relate a", "div.relate_srch a",
            "div[class*='related'] a",
        ]:
            for a in soup.select(sel):
                kw = _clean_kw(a.get_text())
                if _valid_kw(kw):
                    found.append(kw)
            if found:
                break

    return list(dict.fromkeys(found))


def _related_from_page(page, keyword) -> list[str]:
    """이미 떠 있는 페이지를 재사용해 검색 후 '함께 많이 찾는'/연관검색어 추출."""
    url = f"https://search.naver.com/search.naver?query={quote(keyword)}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # '함께 많이 찾는' 박스는 페이지 하단 → 스크롤로 로드 유도
        for _ in range(4):
            page.mouse.wheel(0, 1300)
            time.sleep(0.4)
        time.sleep(0.6)
        return extract_related_from_html(page.content())
    except Exception:
        return []


def _process_batch(targets, progress_cb, depth):
    """
    targets 키워드들을 MAX_WORKERS개 워커로 병렬 처리.
    워커마다 브라우저를 '한 번만' 띄우고 페이지만 새로 열어 재사용한다.
    반환: {keyword: [suggestions...]}
    """
    import threading
    import queue as _queue
    from playwright.sync_api import sync_playwright

    q = _queue.Queue()
    for kw in targets:
        q.put(kw)

    results = {}
    lock = threading.Lock()
    counter = {"done": 0}
    total = len(targets)

    def _worker():
        pw = browser = None
        try:
            pw = sync_playwright().start()
            browser = pw.chromium.launch(headless=True, args=LOW_MEM_ARGS)
            while True:
                try:
                    kw = q.get_nowait()
                except _queue.Empty:
                    break
                # 자동완성 API (가벼움) + 브라우저로 함께 많이 찾는
                ac = get_naver_autocomplete(kw)
                related = []
                page = None
                try:
                    page = browser.new_page(
                        user_agent=random.choice(USER_AGENTS), locale="ko-KR")
                    related = _related_from_page(page, kw)
                except Exception:
                    pass
                finally:
                    try:
                        if page: page.close()
                    except Exception:
                        pass
                combined = list(dict.fromkeys(ac + related))
                with lock:
                    results[kw] = combined
                    counter["done"] += 1
                    if progress_cb:
                        progress_cb(counter["done"], total, depth, kw)
                time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        finally:
            try:
                if browser: browser.close()
                if pw: pw.stop()
            except Exception:
                pass

    workers = [threading.Thread(target=_worker, daemon=True)
               for _ in range(min(MAX_WORKERS, max(1, total)))]
    for w in workers:
        w.start()
    for w in workers:
        w.join()

    return results


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

        batch = _process_batch(targets, progress_cb, depth)

        next_level = set()
        for kw, suggestions in batch.items():
            for s in suggestions:
                all_keywords.add(s)
                if s not in visited:
                    next_level.add(s)

        current_level = next_level
        if depth < max_depth - 1 and next_level:
            time.sleep(DEPTH_DELAY)

    return sorted(all_keywords)
