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

# 잡음 제거용 패턴
_URL_RE = re.compile(r"(https?://|www\.|\.com|\.co\.kr|\.kr|\.io|\.net|\.org|/)", re.I)
_NUMERIC_RE = re.compile(r"^[\d,.\s년월일주시간개]+$")     # 숫자/날짜/기간만으로 구성
_DATE_RE = re.compile(r"^\d{4}([.\-/]\d{1,2}){0,2}\.?$")    # 2026 / 2026.06.29.
_JUNK_WORDS = (
    "열기", "더보기", "바로가기", "저장", "가이드", "신고", "도움말",
    "Keep", "OpenStreetMap", "지도", "길찾기", "전화", "예약", "공유",
)
# 게시글 제목/카페명에 흔한 특수문자 (연관검색어엔 거의 없음)
_SPECIAL_CHARS = set("[]{}◆♥«»【】~|·…“”\"")


def _clean_kw(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    t = _BADGE_RE.sub("", t).strip()
    return t


def _valid_kw(text: str) -> bool:
    """연관검색어/자동완성처럼 보이는 짧은 검색어만 통과."""
    if not text:
        return False
    # 연관검색어는 보통 짧다. 너무 길면 게시글 제목/댓글로 간주.
    if not (2 <= len(text) <= 25):
        return False
    if _URL_RE.search(text):
        return False
    if _NUMERIC_RE.match(text):
        return False
    if _DATE_RE.match(text):
        return False
    if any(text.endswith(w) or w in text for w in _JUNK_WORDS):
        return False
    if any(c in _SPECIAL_CHARS for c in text):
        return False
    return True


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
    #    헤딩에서 위로 올라가되, '딱 그 박스'만 잡도록 링크 수가
    #    적당한(2~20개) 가장 작은 조상만 채택한다. (페이지 전체를 긁지 않도록)
    heading_pat = re.compile(r"(함께\s*많이\s*찾는|연관\s*검색어)")
    for node in soup.find_all(string=heading_pat):
        container = node.parent
        chosen = None
        for _ in range(6):
            if container is None:
                break
            links = container.find_all("a")
            n = len(links)
            if 2 <= n <= 20:
                chosen = container  # 계속 올라가며 마지막으로 맞는 박스 갱신
            elif n > 20:
                break               # 너무 커지면 중단 (전체 섹션)
            container = container.parent
        if chosen:
            for a in chosen.find_all("a"):
                kw = _clean_kw(a.get_text())
                if _valid_kw(kw):
                    found.append(kw)

    # 2) 클래스 기반 보조 셀렉터 (헤딩 탐색 실패 시에만, 좁은 셀렉터만)
    if not found:
        for sel in [
            "div.related_srch a", "ul.related_srch a",
            "div.keyword_relate a", "div.relate_srch a",
        ]:
            for a in soup.select(sel):
                kw = _clean_kw(a.get_text())
                if _valid_kw(kw):
                    found.append(kw)
            if found:
                break

    return list(dict.fromkeys(found))


def diagnose_keyword(keyword) -> dict:
    """
    단일 키워드를 동기 실행하며 각 단계의 상태를 리포트한다.
    (네이버 접근/셀렉터 문제를 화면에서 바로 진단하기 위한 용도)
    """
    from playwright.sync_api import sync_playwright
    report = {
        "keyword": keyword,
        "autocomplete_count": 0, "autocomplete_sample": [],
        "related_count": 0, "related_sample": [],
        "page_title": "", "html_len": 0,
        "found_heading_text": False, "total_links_in_page": 0,
        "error": "",
    }

    # 1) 자동완성 API (진단 시에는 raw 응답/에러를 직접 확인)
    try:
        ac_url = "https://ac.search.naver.com/nx/ac"
        ac_params = {
            "q": keyword, "st": 100, "r_format": "json",
            "r_enc": "UTF-8", "r_unicode": 0, "t_koreng": 1,
            "run": 2, "rev": 4, "q_enc": "UTF-8",
        }
        ac_headers = {
            "User-Agent": random.choice(USER_AGENTS),
            "Referer": "https://www.naver.com/",
            "Accept": "*/*",
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        }
        rr = requests.get(ac_url, params=ac_params, headers=ac_headers, timeout=REQUEST_TIMEOUT)
        report["autocomplete_http_status"] = rr.status_code
        ac = get_naver_autocomplete(keyword)
        report["autocomplete_count"] = len(ac)
        report["autocomplete_sample"] = ac[:10]
    except Exception as e:
        report["error"] += f"autocomplete: {type(e).__name__}: {e}; "

    # 2) 브라우저 렌더링 + 함께 많이 찾는
    pw = browser = None
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.launch(headless=True, args=LOW_MEM_ARGS)
        page = browser.new_page(user_agent=random.choice(USER_AGENTS), locale="ko-KR")
        url = f"https://search.naver.com/search.naver?query={quote(keyword)}"
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        for _ in range(4):
            page.mouse.wheel(0, 1300)
            time.sleep(0.4)
        time.sleep(0.8)
        html = page.content()
        report["page_title"] = page.title()
        report["html_len"] = len(html)
        soup = BeautifulSoup(html, "html.parser")
        report["total_links_in_page"] = len(soup.find_all("a"))
        report["found_heading_text"] = bool(
            re.search(r"함께\s*많이\s*찾는", html) or re.search(r"연관\s*검색어", html))
        related = extract_related_from_html(html)
        report["related_count"] = len(related)
        report["related_sample"] = related[:10]
    except Exception as e:
        report["error"] += f"browser: {e}; "
    finally:
        try:
            if browser: browser.close()
            if pw: pw.stop()
        except Exception:
            pass

    return report


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
