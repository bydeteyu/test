#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
네이버 카페 게시글 조회수 / 댓글수 추적기
"""

import re
import time
import requests
from datetime import datetime

# Playwright 폴백용 (회원전용 카페 → API 403일 때 화면 숫자 직접 스크랩)
VIEW_RE = re.compile(r'조회\s*([\d,]+)')
COMMENT_RE = re.compile(r'댓글\s*([\d,]+)')

REQUEST_DELAY = 1.5
_clubid_cache = {}

HEADERS_BROWSER = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

HEADERS_API = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

CLUBID_PATTERNS = [
    r'"cafeId"\s*:\s*"?(\d+)"?',
    r'"clubId"\s*:\s*"?(\d+)"?',
    r'clubid=(\d+)',
    r'g_sClubId\s*=\s*["\']([\d]+)["\']',
    r'"cafe_id"\s*:\s*"?(\d+)"?',
    r'cafeId=(\d+)',
]


def make_api_headers(clubid=None, articleid=None, cookie=""):
    h = dict(HEADERS_API)
    if clubid and articleid:
        h["Referer"] = (
            f"https://cafe.naver.com/ca-fe/web/cafes/{clubid}/articles/{articleid}"
        )
    if cookie:
        h["Cookie"] = cookie
    return h


def expand_url(url, session):
    """naver.me 단축 URL → 실제 URL"""
    if "naver.me" in url:
        try:
            r = session.get(
                url, headers=HEADERS_BROWSER,
                allow_redirects=True, timeout=15
            )
            return r.url
        except Exception:
            return url
    return url


def extract_clubid_from_html(html: str):
    for p in CLUBID_PATTERNS:
        m = re.search(p, html)
        if m:
            return m.group(1)
    return None


def resolve_clubid(cafe_name: str, session, article_url: str = ""):
    """cafe_name → 숫자 clubid. 실패 시 article_url 페이지에서 재시도."""
    if cafe_name in _clubid_cache:
        return _clubid_cache[cafe_name]

    # 1) 카페 홈 페이지
    for url in [
        f"https://cafe.naver.com/{cafe_name}",
        article_url,
    ]:
        if not url:
            continue
        try:
            html = session.get(url, headers=HEADERS_BROWSER, timeout=10).text
            cid = extract_clubid_from_html(html)
            if cid:
                _clubid_cache[cafe_name] = cid
                return cid
        except Exception:
            continue

    return None


def parse_url(url: str, session):
    """링크 → (clubid, articleid, expanded_url)"""
    original = url.strip()
    expanded = expand_url(original, session)

    for u in [expanded, original]:
        # 구형 querystring
        m = re.search(r'clubid=(\d+).*?articleid=(\d+)', u, re.IGNORECASE)
        if m:
            return m.group(1), m.group(2), expanded

        # 모바일/신형 API 형태
        m = re.search(r'cafes/(\d+)/articles/(\d+)', u)
        if m:
            return m.group(1), m.group(2), expanded

        # 신형 cafe.naver.com/slug/number
        m = re.search(r'cafe\.naver\.com/([^/?#]+)/(\d+)', u)
        if m:
            cafe_name, articleid = m.group(1), m.group(2)
            clubid = resolve_clubid(cafe_name, session, article_url=u)
            if clubid:
                return clubid, articleid, expanded

    return None, None, expanded


def deep_find(obj, target_keys):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in target_keys and isinstance(v, (int, float)):
                return int(v)
        for v in obj.values():
            found = deep_find(v, target_keys)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = deep_find(item, target_keys)
            if found is not None:
                return found
    return None


def find_title(o):
    if isinstance(o, dict):
        for k in ("subject", "title"):
            if k in o and isinstance(o[k], str) and o[k].strip():
                return o[k].strip()
        for v in o.values():
            t = find_title(v)
            if t:
                return t
    elif isinstance(o, list):
        for v in o:
            t = find_title(v)
            if t:
                return t
    return None


def fetch_and_extract(clubid, articleid, session, cookie=""):
    api = (
        f"https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/"
        f"cafes/{clubid}/articles/{articleid}"
        f"?query=&menuId=0&boardType=L&useCafeId=true&requestFrom=A"
    )
    r = session.get(
        api,
        headers=make_api_headers(clubid, articleid, cookie),
        timeout=10
    )
    r.raise_for_status()
    data = r.json()
    read = deep_find(data, {"readCount", "viewCount", "readcount", "hit"})
    comment = deep_find(data, {"commentCount", "commentcount", "replyCount"})
    title = find_title(data)
    return title, read, comment


def _counts_from_text(text: str):
    """렌더된 페이지 텍스트에서 조회수/댓글수 추출"""
    read = comment = None
    m = VIEW_RE.search(text)
    if m:
        try:
            read = int(m.group(1).replace(",", ""))
        except ValueError:
            pass
    m = COMMENT_RE.search(text)
    if m:
        try:
            comment = int(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return read, comment


def fetch_via_browser(page, url: str):
    """
    실제 카페 글 페이지를 렌더링해서 화면에 보이는
    조회수/댓글수/제목을 직접 스크랩 (회원전용 카페 폴백).
    """
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    time.sleep(2.5)

    title = read = comment = None

    # 페이지 본문 + 모든 iframe(cafe_main 등) 텍스트를 모아서 검색
    texts = []
    try:
        texts.append(page.inner_text("body"))
    except Exception:
        pass
    for fr in page.frames:
        try:
            texts.append(fr.inner_text("body"))
        except Exception:
            continue

    for t in texts:
        if not t:
            continue
        r, c = _counts_from_text(t)
        if read is None and r is not None:
            read = r
        if comment is None and c is not None:
            comment = c

    # 제목: og:title 또는 페이지 타이틀
    try:
        og = page.locator('meta[property="og:title"]')
        if og.count() > 0:
            title = og.first.get_attribute("content")
    except Exception:
        pass
    if not title:
        try:
            t = page.title()
            # "글 제목 : 네이버 카페" 형태 정리
            title = re.split(r"\s*[:：]\s*", t)[0].strip() if t else None
        except Exception:
            pass

    return title, read, comment


TRACKER_API_WORKERS = 8   # API 호출 병렬 수 (HTTP I/O라 넉넉하게)
TRACKER_PW_WORKERS  = 2   # Playwright 폴백 병렬 수 (메모리 보호)

_PW_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--disable-extensions", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI", "--js-flags=--max-old-space-size=512",
]


def _make_browser_page(cookie: str):
    """독립 Playwright 컨텍스트+페이지 생성 (스레드별로 호출)."""
    from playwright.sync_api import sync_playwright
    pw  = sync_playwright().start()
    browser = pw.chromium.launch(headless=True, args=_PW_ARGS)
    ctx = browser.new_context(user_agent=HEADERS_BROWSER["User-Agent"], locale="ko-KR")
    if cookie:
        parsed = []
        for part in cookie.split(";"):
            if "=" not in part:
                continue
            name, _, value = part.strip().partition("=")
            if name:
                parsed.append({"name": name, "value": value,
                               "domain": ".naver.com", "path": "/"})
        if parsed:
            try:
                ctx.add_cookies(parsed)
            except Exception:
                pass
    page = ctx.new_page()
    return pw, browser, page


def run_tracker(urls: list[str], cookie: str = "",
                progress_cb=None) -> list[dict]:
    """
    progress_cb(done, total): 진행 상황 콜백 (선택)
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    valid_urls = [u.strip() for u in urls if u.strip() and not u.strip().startswith("#")]
    total = len(valid_urls)
    rows_map: dict[str, dict] = {}
    done_count = 0
    lock = time.time  # 재사용 방지용 — 실제 lock은 아래에서
    import threading as _th
    lock = _th.Lock()
    pw_semaphore = _th.Semaphore(TRACKER_PW_WORKERS)

    # 1단계: URL 파싱 + API 호출 (병렬)
    shared_session = requests.Session()

    def _process_url(url):
        session = requests.Session()  # 스레드별 독립 세션
        clubid, articleid, expanded = parse_url(url, session)
        if not (clubid and articleid):
            return url, {
                "date": today, "clubid": "", "articleid": "",
                "title": "URL 해석 실패", "read_count": "", "comment_count": "",
                "url": url, "error": f"parse_fail (expanded: {expanded})",
                "_needs_browser": False,
            }
        title = read = comment = None
        api_error = ""
        try:
            title, read, comment = fetch_and_extract(clubid, articleid, session, cookie)
        except Exception as e:
            api_error = str(e)

        needs_browser = (read is None and comment is None)
        return url, {
            "date": today, "clubid": clubid, "articleid": articleid,
            "title": title or "", "read_count": read, "comment_count": comment,
            "url": url, "error": api_error,
            "_needs_browser": needs_browser,
            "_expanded": expanded,
        }

    with ThreadPoolExecutor(max_workers=TRACKER_API_WORKERS) as pool:
        futures = {pool.submit(_process_url, u): u for u in valid_urls}
        for fut in as_completed(futures):
            url, row = fut.result()
            rows_map[url] = row
            with lock:
                done_count += 1
                if progress_cb:
                    progress_cb(done_count, total)

    # 2단계: API 실패 URL만 Playwright 폴백 (병렬 TRACKER_PW_WORKERS개)
    browser_urls = [u for u in valid_urls if rows_map[u].get("_needs_browser")]

    def _browser_fallback(url):
        row = rows_map[url]
        b_url = row.get("_expanded") or url
        pw = browser = page = None
        with pw_semaphore:
            try:
                pw, browser, page = _make_browser_page(cookie)
                bt, br, bc = fetch_via_browser(page, b_url)
                if not row["title"]:
                    row["title"] = bt or ""
                if br is not None:
                    row["read_count"] = br
                if bc is not None:
                    row["comment_count"] = bc
            except Exception as e:
                if not row["error"]:
                    row["error"] = f"browser_fail: {e}"
            finally:
                try:
                    if browser: browser.close()
                    if pw: pw.stop()
                except Exception:
                    pass
        with lock:
            got = (row["read_count"] is not None) or (row["comment_count"] is not None)
            if not got and not row["error"]:
                row["error"] = "데이터 없음"

    if browser_urls:
        with ThreadPoolExecutor(max_workers=TRACKER_PW_WORKERS) as pool:
            list(pool.map(_browser_fallback, browser_urls))

    # 입력 순서로 정렬 후 내부 키 제거
    result = []
    for url in valid_urls:
        row = rows_map[url]
        got = (row["read_count"] is not None) or (row["comment_count"] is not None)
        result.append({
            "date":          row["date"],
            "clubid":        row["clubid"],
            "articleid":     row["articleid"],
            "title":         row["title"],
            "read_count":    row["read_count"] if row["read_count"] is not None else "",
            "comment_count": row["comment_count"] if row["comment_count"] is not None else "",
            "url":           row["url"],
            "error":         "" if got else row["error"],
        })
    return result
