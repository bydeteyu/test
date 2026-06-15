"""
Naver cafe post collection.

Primary:  Naver Cafe Article Search API (openapi.naver.com)
          - requires NAVER_CLIENT_ID + NAVER_CLIENT_SECRET
          - does NOT require login, no bot blocking
Fallback: Direct HTML scraping of search.naver.com
          - frequently blocked (403) from non-browser environments
"""

import os
import time
import random
import logging
from datetime import datetime, timedelta
from typing import Optional
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

NAVER_CAFE_API = "https://openapi.naver.com/v1/search/cafearticle.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://search.naver.com/",
}


def _parse_naver_date(date_str: str) -> Optional[str]:
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


def _parse_naver_pubdate(pubdate: str) -> str:
    """Parse 'Mon, 09 Jun 2026 14:23:00 +0900' → 'YYYY-MM-DD'."""
    try:
        dt = datetime.strptime(pubdate[:16], "%a, %d %b %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return pubdate[:10] if pubdate else ""


def _search_via_api(
    keyword: str,
    cafe_slug: str,
    client_id: str,
    client_secret: str,
    max_results: int = 50,
) -> list[dict]:
    """Use Naver Cafe Article Search API. Filters to target cafe_slug."""
    results = []
    cutoff = datetime.today() - timedelta(days=7)
    start = 1
    display = 100  # max per request

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }

    while len(results) < max_results:
        resp = requests.get(
            NAVER_CAFE_API,
            headers=headers,
            params={
                "query": keyword,
                "display": display,
                "start": start,
                "sort": "date",
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items", [])
        if not items:
            break

        found_old = False
        for item in items:
            # Filter to target cafe
            cafe_url = item.get("cafename", "") or item.get("cafeurl", "")
            link = item.get("link", "")
            if cafe_slug and cafe_slug not in link and cafe_slug not in cafe_url:
                continue

            pubdate = _parse_naver_pubdate(item.get("pubDate", ""))
            if pubdate:
                try:
                    post_dt = datetime.strptime(pubdate, "%Y-%m-%d")
                    if post_dt < cutoff:
                        found_old = True
                        continue
                except ValueError:
                    pass

            # Strip HTML tags from title
            title = BeautifulSoup(item.get("title", ""), "html.parser").get_text()

            results.append({
                "title": title,
                "url": link,
                "date": pubdate,
                "cafe": cafe_slug,
                "keyword": keyword,
                "views": 0,
                "comments": 0,
            })

        if found_old or len(items) < display:
            break
        start += display
        time.sleep(0.3)

    return results[:max_results]


def _search_via_scraping(
    keyword: str, cafe_slug: str, max_results: int = 20
) -> list[dict]:
    """Fallback HTML scraping. Often blocked (403) outside browser env."""
    results = []
    cutoff = datetime.today() - timedelta(days=7)
    page = 1

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
            logger.debug("스크래핑 차단 [%s/%s]: %s", cafe_slug, keyword, e)
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        items = soup.select("li.bx")
        if not items:
            break

        found_old = False
        for item in items:
            title_el = item.select_one("a.cafe_txt, .title_link, a[class*='title']")
            date_el = item.select_one(".sub_txt.sub_time, .date, .result_sub_time")
            url_el = item.select_one("a[href]")

            title = title_el.get_text(strip=True) if title_el else ""
            raw_date = date_el.get_text(strip=True) if date_el else ""
            post_url = url_el["href"] if url_el else ""

            if not title:
                continue

            parsed_date = _parse_naver_date(raw_date)
            if parsed_date:
                try:
                    if datetime.strptime(parsed_date, "%Y-%m-%d") < cutoff:
                        found_old = True
                        continue
                except ValueError:
                    pass

            results.append({
                "title": title,
                "url": post_url,
                "date": parsed_date or raw_date,
                "cafe": cafe_slug,
                "keyword": keyword,
                "views": 0,
                "comments": 0,
            })

        if found_old or len(items) < 10:
            break
        page += 1
        time.sleep(random.uniform(1.0, 2.5))

    return results[:max_results]


def collect_all_cafes(seed_keywords: list[str], cafes: list[dict]) -> list[dict]:
    """
    Collect posts from all cafes for all seed keywords.
    Uses Naver Search API when credentials available, scraping as fallback.
    Gracefully continues if individual combos fail.
    """
    client_id = os.getenv("NAVER_CLIENT_ID", "")
    client_secret = os.getenv("NAVER_CLIENT_SECRET", "")
    use_api = bool(client_id and client_secret)

    if use_api:
        logger.info("Naver 카페검색 API 사용 (공식 API)")
    else:
        logger.warning(
            "NAVER_CLIENT_ID/SECRET 미설정 → 스크래핑 시도 (403 차단될 수 있음). "
            "안정적인 수집을 위해 https://developers.naver.com 에서 API 키를 발급받으세요."
        )

    all_posts = []
    total = len(seed_keywords) * len(cafes)
    done = 0

    for cafe in cafes:
        for keyword in seed_keywords:
            done += 1
            logger.info("[%d/%d] 수집 중: %s @ %s", done, total, keyword, cafe["slug"])
            try:
                if use_api:
                    posts = _search_via_api(
                        keyword, cafe["slug"], client_id, client_secret, max_results=50
                    )
                else:
                    posts = _search_via_scraping(keyword, cafe["slug"], max_results=20)
                all_posts.extend(posts)
                if posts:
                    logger.debug("  → %d건 수집", len(posts))
            except Exception as e:
                logger.warning("수집 실패 [%s/%s]: %s", cafe["slug"], keyword, e)
            time.sleep(random.uniform(0.3, 0.8) if use_api else random.uniform(1.0, 2.0))

    logger.info("카페 수집 완료: 총 %d건", len(all_posts))
    return all_posts
