#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
네이버 카페 게시글 조회수 / 댓글수 추적기
"""

import re
import time
import requests
from datetime import datetime

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


def run_tracker(urls: list[str], cookie: str = "") -> list[dict]:
    session = requests.Session()
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    rows = []
    for url in urls:
        url = url.strip()
        if not url or url.startswith("#"):
            continue
        clubid, articleid, expanded = parse_url(url, session)
        if not (clubid and articleid):
            rows.append({
                "date": today, "clubid": "", "articleid": "",
                "title": "URL 해석 실패",
                "read_count": "", "comment_count": "",
                "url": url,
                "error": f"parse_fail (expanded: {expanded})"
            })
            continue
        try:
            title, read, comment = fetch_and_extract(
                clubid, articleid, session, cookie
            )
            rows.append({
                "date": today, "clubid": clubid, "articleid": articleid,
                "title": title or "",
                "read_count": read if read is not None else "",
                "comment_count": comment if comment is not None else "",
                "url": url, "error": ""
            })
        except Exception as e:
            rows.append({
                "date": today, "clubid": clubid, "articleid": articleid,
                "title": "", "read_count": "", "comment_count": "",
                "url": url, "error": str(e)
            })
        time.sleep(REQUEST_DELAY)
    return rows
