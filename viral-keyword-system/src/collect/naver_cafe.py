"""
Naver cafe post collection via search.
Gracefully degrades if blocked or rate-limited.
"""

import time
import random
import logging
from datetime import datetime, timedelta
from typing import Optional
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://search.naver.com/",
}


def _parse_naver_date(date_str: str) -> Optional[str]:
    """Convert Naver relative dates to YYYY-MM-DD."""
    today = datetime.today()
    date_str = date_str.strip()
    try:
        if "분 전" in date_str or "시간 전" in date_str:
            return today.strftime("%Y-%m-%d")
        if "일 전" in date_str:
            days = int(date_str.replace("일 전", "").strip())
            return (today - timedelta(days=days)).strftime("%Y-%m-%d")
        if "." in date_str:
            parts = date_str.split(".")
            if len(parts) == 3:
                y = int(parts[0]) if len(parts[0]) == 4 else 2000 + int(parts[0])
                return f"{y}-{int(parts[1]):02d}-{int(parts[2]):02d}"
        return date_str
    except Exception:
        return None


def search_cafe_keyword(
    keyword: str, cafe_slug: str, max_results: int = 50
) -> list[dict]:
    """
    Search Naver for posts in a specific cafe matching keyword.
    Returns list of {title, url, date, cafe, views, comments}.
    """
    results = []
    page = 1
    cutoff = datetime.today() - timedelta(days=7)

    while len(results) < max_results:
        url = (
            "https://search.naver.com/search.naver"
            f"?where=article&query={requests.utils.quote(keyword)}"
            f"&cafe_url=cafe.naver.com/{cafe_slug}"
            f"&start={(page-1)*10+1}"
        )
        try:
            resp = requests.get(url, headers=HEADERS, timeout=10)
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.warning("cafe search failed [%s/%s]: %s", cafe_slug, keyword, e)
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        items = soup.select("li.bx")
        if not items:
            break

        found_old = False
        for item in items:
            title_el = item.select_one("a.cafe_txt, .title_link, a[class*='title']")
            date_el = item.select_one(".sub_txt.sub_time, .date, .result_sub_time")
            view_el = item.select_one(".sub_txt:not(.sub_time)")
            url_el = item.select_one("a[href]")

            title = title_el.get_text(strip=True) if title_el else ""
            raw_date = date_el.get_text(strip=True) if date_el else ""
            post_url = url_el["href"] if url_el else ""

            if not title:
                continue

            parsed_date = _parse_naver_date(raw_date)
            if parsed_date:
                try:
                    post_dt = datetime.strptime(parsed_date, "%Y-%m-%d")
                    if post_dt < cutoff:
                        found_old = True
                        continue
                except ValueError:
                    pass

            results.append(
                {
                    "title": title,
                    "url": post_url,
                    "date": parsed_date or raw_date,
                    "cafe": cafe_slug,
                    "keyword": keyword,
                    "views": 0,
                    "comments": 0,
                }
            )

        if found_old or len(items) < 10:
            break

        page += 1
        time.sleep(random.uniform(1.0, 2.5))

    return results[:max_results]


def collect_all_cafes(seed_keywords: list[str], cafes: list[dict]) -> list[dict]:
    """
    Collect posts from all cafes for all seed keywords.
    Gracefully continues if individual cafe/keyword combos fail.
    """
    all_posts = []
    total = len(seed_keywords) * len(cafes)
    done = 0

    for cafe in cafes:
        for keyword in seed_keywords:
            done += 1
            logger.info("[%d/%d] 수집 중: %s @ %s", done, total, keyword, cafe["slug"])
            try:
                posts = search_cafe_keyword(keyword, cafe["slug"], max_results=50)
                all_posts.extend(posts)
                logger.debug("  → %d건 수집", len(posts))
            except Exception as e:
                logger.warning("수집 실패 [%s/%s]: %s", cafe["slug"], keyword, e)
            time.sleep(random.uniform(0.5, 1.5))

    logger.info("카페 수집 완료: 총 %d건", len(all_posts))
    return all_posts
