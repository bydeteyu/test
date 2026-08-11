"""
일일 카페글 노출 체크
======================
감시 키워드 목록(alert_store)을 순회하며 네이버 통합검색에서 카페글이
노출되는지 확인(naver_cafe_collector 재사용)하고, 결과를 슬랙으로
보낸 뒤 마지막 실행 결과를 저장한다.

주의: '통합검색'에서 실제로 노출되는 카페글만 뽑는 것이지, 블로그/뉴스
등과 뒤섞인 정확한 '몇 번째 노출'인지까지는 계산하지 않는다 — 노출
여부/목록 확인이 목적이다.
"""

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import alert_store
from alert_notifier import send_slack_digest, slack_ready
from naver_cafe_collector import extract_posts, fetch_html

KST = ZoneInfo("Asia/Seoul")
ALERT_WORKERS = 2  # naver_cafe_collector의 COLLECT_WORKERS와 동일한 메모리 제약 고려


def _check_keyword(keyword: str) -> dict:
    try:
        html = fetch_html(keyword, headless=True)
        posts = extract_posts(html)
        return {"keyword": keyword, "posts": posts, "error": None}
    except Exception as e:
        return {"keyword": keyword, "posts": [], "error": str(e)}


def run_alert_check(keywords: list[str] | None = None, notify: bool = True) -> dict:
    """키워드들을 확인하고 결과 요약을 반환. notify=True면 슬랙으로도 전송."""
    keywords = keywords if keywords is not None else alert_store.list_keywords()
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d %H:%M") + " KST"

    results = []
    if keywords:
        with ThreadPoolExecutor(max_workers=ALERT_WORKERS) as pool:
            results = list(pool.map(_check_keyword, keywords))
        order = {kw: i for i, kw in enumerate(keywords)}
        results.sort(key=lambda r: order.get(r["keyword"], 0))

    summary = {
        "ran_at": date_str,
        "keywords_checked": len(keywords),
        "total_hits": sum(len(r["posts"]) for r in results if not r.get("error")),
        "results": results,
        "notified": False,
        "notify_error": None,
    }

    if notify and keywords:
        if slack_ready():
            try:
                send_slack_digest(date_str, results)
                summary["notified"] = True
            except Exception as e:
                summary["notify_error"] = str(e)
        else:
            summary["notify_error"] = "SLACK_WEBHOOK_URL이 설정되지 않아 전송을 건너뜀"

    alert_store.save_last_run(summary)
    return summary
