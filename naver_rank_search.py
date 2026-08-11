"""
네이버 카페 검색 순위 + 매치도 찍기
키워드로 통합검색 카페탭 30위까지 수집 → 제목 매치도 계산
"""

import re
import time
from urllib.parse import quote
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup


def match_score(keyword: str, title: str) -> int:
    """키워드 단어들이 제목에 얼마나 포함되는지 0-100으로 반환"""
    kw = keyword.strip().lower()
    ti = title.strip().lower()
    
    # 완전 일치
    if kw == ti:
        return 100
    
    # 키워드 단어 분할 후 각 단어가 제목에 포함되는 비율
    words = [w for w in re.split(r'\s+', kw) if w]
    if not words:
        return 0
    matched = sum(1 for w in words if w in ti)
    return round(matched / len(words) * 100)


LOW_MEM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI",
    "--js-flags=--max-old-space-size=512",
]


def fetch_rank_html(keyword: str) -> str:
    url = f"https://search.naver.com/search.naver?query={quote(keyword)}&where=article"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LOW_MEM_ARGS)
        page = browser.new_page(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="ko-KR",
        )
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        for _ in range(5):
            page.mouse.wheel(0, 1200)
            time.sleep(0.5)
        time.sleep(1)
        html = page.content()
        browser.close()
    return html


ARTICLE_NEW = re.compile(r"cafe\.naver\.com/f-e/cafes/(\d+)/articles/(\d+)")
ARTICLE_OLD = re.compile(r"cafe\.naver\.com/(?!f-e/)([^/?#]+)/(\d+)")
CAFE_HOME   = re.compile(r"cafe\.naver\.com/(?!f-e/)([^/?#]+)/?(?:[?#]|$)")


def is_article(href):
    return bool(ARTICLE_NEW.search(href) or ARTICLE_OLD.search(href))


# 카페 홈 링크 중에는 "새 창 열림" 같은 스크린리더 전용 안내 문구만 담긴
# 아이콘/버튼 링크도 있다. 카페명으로 그 문구가 잡히지 않도록 걸러낸다.
HIDDEN_LABEL_RE = re.compile(r"^(새\s*창\s*열림|동영상\s*재생|바로가기|더보기)$")


def _anchor_visible_text(a) -> str:
    """앵커의 보이는 텍스트만 추출한다 (.blind 등 숨김 라벨 제외)."""
    clone = BeautifulSoup(str(a), "html.parser")
    for hidden in clone.select(".blind, [aria-hidden='true']"):
        hidden.decompose()
    return re.sub(r"\s+", " ", clone.get_text(strip=True)).strip()


def find_cafe_name(anchor):
    node = anchor
    for _ in range(8):
        node = node.parent
        if node is None:
            break
        for a in node.find_all("a", href=True):
            if CAFE_HOME.search(a["href"]) and not is_article(a["href"]):
                name = _anchor_visible_text(a)
                if name and not HIDDEN_LABEL_RE.match(name):
                    return name
    return None


def extract_ranked_posts(html: str, keyword: str, top_n: int = 30) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    seen, posts = set(), []

    for a in soup.find_all("a", href=True):
        if not is_article(a["href"]):
            continue
        title = re.sub(r"\s+", " ", a.get_text()).strip()
        title = re.sub(r"[.…]{2,}$", "", title).strip()
        if not title or len(title) < 2:
            continue
        href = a["href"]
        if href in seen:
            continue
        seen.add(href)

        rank = len(posts) + 1
        score = match_score(keyword, title)
        cafe = find_cafe_name(a) or ""

        posts.append({
            "rank": rank,
            "title": title,
            "cafe": cafe,
            "score": score,
            "link": href,
        })

        if rank >= top_n:
            break

    return posts


def run_rank_search(keywords: list[str], top_n: int = 30) -> list[dict]:
    results = []
    for kw in keywords:
        try:
            html = fetch_rank_html(kw)
            posts = extract_ranked_posts(html, kw, top_n)
        except Exception as e:
            posts = [{"rank": "-", "title": str(e), "cafe": "", "score": 0, "link": ""}]
        results.append({"keyword": kw, "posts": posts})
    return results
