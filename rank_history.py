"""
순위 기록 — 키워드 검색 시 통합검색 / 카페탭 순위를 확인하고 날짜별로 기록
==========================================================================
- 키워드를 검색하면 통합검색(블로그·카페 게시글 노출 순서)과 카페탭 각각 상위 30위를
  수집해 "스냅샷"으로 저장한다 (같은 날 다시 검색하면 덮어씀).
- 추적 콘텐츠(키워드 + 제목 문구 또는 글 주소)를 등록하면, 스냅샷에서 그 글의
  통합 순위 / 카페탭 순위를 판정해 날짜별로 기록한다 (20위 안에 없으면 "20위 밖").
- 저장 위치는 monitor_store와 같은 DATA_DIR (Railway에서는 Volume 필요).

기존 /rank(검색 순위), 카페글 노출 알림과는 독립된 모듈이다.
"""

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from naver_cafe_collector import (
    _anchor_visible_text, article_key, clean_title, find_cafe_info, make_canonical_url,
    ARTICLE_NEW, ARTICLE_OLD,
)

KST = ZoneInfo("Asia/Seoul")
DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
STORE_FILE = DATA_DIR / "rank_history.json"

SNAPSHOT_TOP = 30      # 키워드 검색 시 저장하는 상위 개수
TRACK_TOP = 20         # 추적 콘텐츠 순위 판정 범위
KEEP_DAYS = 120
MAX_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 6
CHANNELS = ("integrated", "cafe")

_lock = threading.Lock()

BLOG_PATH = re.compile(r"blog\.naver\.com/([^/?#]+)/(\d+)")
BLOG_QUERY = re.compile(r"blog\.naver\.com/PostView\.\w+\?[^#]*")


def today() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


# ── 검색 결과 HTML → 순위 목록 ─────────────────────────────────
def _post_key(href: str):
    """게시글이면 (key, type, slug), 아니면 (None, None, None). 카페글·블로그글만 대상."""
    key, slug = article_key(href)
    if key:
        return key, "cafe", slug
    m = BLOG_PATH.search(href)
    if m:
        return f"blog:{m.group(1)}/{m.group(2)}", "blog", m.group(1)
    if BLOG_QUERY.search(href):
        q = dict(p.split("=", 1) for p in href.split("?", 1)[1].split("#")[0].split("&") if "=" in p)
        if q.get("blogId") and q.get("logNo"):
            return f"blog:{q['blogId']}/{q['logNo']}", "blog", q["blogId"]
    return None, None, None


def extract_ranked(html: str, only_cafe: bool = False, top_n: int = SNAPSHOT_TOP) -> list[dict]:
    """문서 순서대로 게시글에 순위를 매긴다. 같은 글의 중복 링크(썸네일/댓글 미리보기)는 한 번만 센다.

    제목은 그 글의 링크 중 '텍스트가 있는 첫 링크'를 쓴다 (댓글 미리보기가 제목을 덮어쓰지 않도록).
    """
    soup = BeautifulSoup(html, "html.parser")
    by_key: dict[str, dict] = {}
    order: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        key, kind, slug = _post_key(href)
        if not key or (only_cafe and kind != "cafe"):
            continue
        title = clean_title(_anchor_visible_text(a))
        has_title = len(title) >= 2
        rec = by_key.get(key)
        if rec is None:
            rec = by_key[key] = {"key": key, "type": kind, "title": "", "cafe": "", "link": "", "_href": href, "_slug": slug}
            order.append(key)
        if has_title and not rec["title"]:
            rec["title"] = title
            if kind == "cafe":
                name, cafe_slug = find_cafe_info(a)
                rec["cafe"] = name or ""
                rec["_slug"] = rec["_slug"] or cafe_slug or ""
            else:
                rec["cafe"] = "블로그"
    posts = []
    for key in order:
        rec = by_key[key]
        if not rec["title"]:
            continue  # 제목 텍스트가 한 번도 안 나온 링크(광고/이미지 전용)는 순위에서 제외
        href = rec["_href"]
        if rec["type"] == "cafe":
            m_new, m_old = ARTICLE_NEW.search(href), ARTICLE_OLD.search(href)
            article_id = m_new.group(2) if m_new else (m_old.group(2) if m_old else "")
            rec["link"] = make_canonical_url(href, rec["_slug"], article_id)
            rec["cafe"] = rec["cafe"] or rec["_slug"] or "(확인필요)"
        else:
            rec["link"] = href if href.startswith("http") else "https://" + href.lstrip("/")
        posts.append({"rank": len(posts) + 1, "type": rec["type"], "title": rec["title"],
                      "cafe": rec["cafe"], "link": rec["link"], "key": key})
        if len(posts) >= top_n:
            break
    return posts


# ── 추적 콘텐츠 매칭 ───────────────────────────────────────────
def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "").lower()


def matches(post: dict, item: dict) -> bool:
    url = (item.get("url") or "").strip()
    if url:
        want_key, _ = article_key(url)
        if want_key and want_key == post.get("key"):
            return True
        stripped = re.sub(r"^https?://(m\.)?", "", url).rstrip("/")
        if stripped and stripped in post.get("link", ""):
            return True
    title = _norm(item.get("title_contains"))
    if title and title in _norm(post.get("title")):
        return True
    return False


def judge(posts, item, top: int = TRACK_TOP) -> dict:
    """posts=None(조회 실패) → error, 범위 안에 있으면 hit+rank, 없으면 miss."""
    if not posts:
        return {"status": "error"}
    for p in posts[:top]:
        if matches(p, item):
            return {"status": "hit", "rank": p["rank"], "title": p["title"]}
    return {"status": "miss"}


# ── 저장소 ─────────────────────────────────────────────────────
def _load() -> dict:
    try:
        return json.loads(STORE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"items": [], "history": {}, "snapshots": {}}


def _save(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STORE_FILE)


def _prune(by_date: dict) -> None:
    for d in sorted(by_date)[:-KEEP_DAYS]:
        by_date.pop(d, None)


def list_items() -> list[dict]:
    with _lock:
        d = _load()
        return [{**i, "history": d["history"].get(i["id"], {})} for i in d["items"]]


def add_item(keyword: str, title_contains: str, url: str, label: str = "") -> dict:
    item = {"id": uuid.uuid4().hex[:12], "keyword": keyword.strip(), "title_contains": title_contains.strip(),
            "url": url.strip(), "label": (label.strip() or title_contains.strip() or url.strip())}
    with _lock:
        d = _load()
        d["items"].append(item)
        _save(d)
    return item


def delete_item(item_id: str) -> None:
    with _lock:
        d = _load()
        d["items"] = [i for i in d["items"] if i["id"] != item_id]
        d["history"].pop(item_id, None)
        _save(d)


def snapshot_keywords() -> list[dict]:
    with _lock:
        return [{"keyword": k, "dates": sorted(v, reverse=True)} for k, v in _load()["snapshots"].items()]


def get_snapshots(keyword: str) -> dict:
    with _lock:
        return _load()["snapshots"].get(keyword, {})


def delete_snapshot_keyword(keyword: str) -> None:
    with _lock:
        d = _load()
        d["snapshots"].pop(keyword, None)
        _save(d)


# ── 조회 (Playwright) ──────────────────────────────────────────
LOW_MEM_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions",
    "--disable-background-networking", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-features=TranslateUI", "--js-flags=--max-old-space-size=512",
]
SEARCH_BASE = os.environ.get("NAVER_SEARCH_BASE", "https://search.naver.com")  # 테스트용 override
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def fetch_pages(keyword: str) -> dict:
    """브라우저 한 번으로 통합검색 / 카페탭 HTML을 함께 가져온다."""
    from playwright.sync_api import sync_playwright
    urls = {
        "integrated": f"{SEARCH_BASE}/search.naver?query={quote(keyword)}",
        "cafe": f"{SEARCH_BASE}/search.naver?query={quote(keyword)}&where=article",
    }
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LOW_MEM_ARGS)
        try:
            page = browser.new_page(user_agent=UA, locale="ko-KR")
            for channel, url in urls.items():
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                for _ in range(6):  # 하위 결과까지 로드되도록 스크롤
                    page.mouse.wheel(0, 1400)
                    time.sleep(0.5)
                time.sleep(1)
                out[channel] = page.content()
        finally:
            browser.close()
    return out


def check_keyword(keyword: str, fetcher=None) -> dict:
    """{'integrated': posts|None, 'cafe': posts|None}. 실패한 채널은 None(미노출과 구분)."""
    fetcher = fetcher or fetch_pages
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            html = fetcher(keyword)
            return {
                "integrated": extract_ranked(html["integrated"]) or None,
                "cafe": extract_ranked(html["cafe"], only_cafe=True) or None,
            }
        except Exception as e:  # noqa: BLE001 — 네트워크/브라우저 오류 전반
            last_error = e
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY_SECONDS)
    print(f"[rank_history] {keyword}: {last_error}")
    return {"integrated": None, "cafe": None}


def record(keyword: str, result: dict, date: str | None = None, only_item_ids=None) -> None:
    """조회 결과를 스냅샷으로 저장하고, 해당 키워드의 추적 콘텐츠 순위를 판정해 기록한다."""
    date = date or today()
    with _lock:
        d = _load()
        # 둘 다 실패한 날은 기존 스냅샷을 덮어쓰지 않는다 (차단된 날 정상 기록이 사라지지 않게)
        if result["integrated"] or result["cafe"]:
            snap = {ch: list(result[ch] or []) for ch in CHANNELS}
            d["snapshots"].setdefault(keyword, {})[date] = snap
            _prune(d["snapshots"][keyword])
        for item in d["items"]:
            if item["keyword"] != keyword or (only_item_ids is not None and item["id"] not in only_item_ids):
                continue
            d["history"].setdefault(item["id"], {})[date] = {ch: judge(result[ch], item) for ch in CHANNELS}
            _prune(d["history"][item["id"]])
        _save(d)


def run_check(keywords: list[str], item_ids=None, progress_cb=None, fetcher=None) -> None:
    """키워드들을 하나씩(브라우저 1개) 조회·기록한다. 같은 키워드는 한 번만."""
    keywords = list(dict.fromkeys(k for k in keywords if k.strip()))
    for i, kw in enumerate(keywords, 1):
        record(kw, check_keyword(kw, fetcher), only_item_ids=item_ids)
        if progress_cb:
            progress_cb(i, len(keywords))
        if i < len(keywords):
            time.sleep(2)


def all_tracked_keywords() -> list[str]:
    """매일 자동 실행 대상: 추적 콘텐츠의 키워드 + 이미 검색해 기록 중인 키워드."""
    with _lock:
        d = _load()
        return list(dict.fromkeys([i["keyword"] for i in d["items"]] + list(d["snapshots"])))
