"""
카페글 노출 체크 (모니터별)
============================
모니터의 감시 키워드 목록을 순회하며 네이버 통합검색에서 카페글이
노출되는지 확인(naver_cafe_collector 재사용)하고, 결과를 그 모니터의
슬랙 웹훅으로 보낸 뒤 실행 결과를 히스토리에 남긴다(monitor_store,
최근 30회 보관 — 매번 덮어쓰지 않는다).

한 모니터 안에서는 키워드를 2개씩 병렬로 처리한다 — /collect, /rank가
이미 이 동시 실행 수(COLLECT_WORKERS=2)로 프로덕션에서 문제없이 돌고
있어서, 여기만 1개씩 도는 건 과했다. 다만 여러 모니터의 스케줄이
겹치는 경우까지 감안하면 동시에 뜨는 브라우저 수가 계속 늘어날 수
있으므로, 모니터 단위 실행 자체는 app.py 쪽 전역 락으로 직렬화해서
"항상 최대 2개 브라우저"를 넘지 않게 막는다. 일시적인 실패는 바로
포기하지 않고 재시도한다.

주의: '통합검색'에서 실제로 노출되는 카페글만 뽑는 것이지, 블로그/뉴스
등과 뒤섞인 정확한 '몇 번째 노출'인지까지는 계산하지 않는다 — 노출
여부/목록 확인이 목적이다.
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import monitor_store
from alert_notifier import send_slack_digest, resolve_webhook_url
from naver_cafe_collector import extract_posts, fetch_html

KST = ZoneInfo("Asia/Seoul")

ALERT_WORKERS = 2          # naver_cafe_collector.COLLECT_WORKERS와 동일 (검증된 값)
MAX_ATTEMPTS = 3           # 키워드 하나당 최대 시도 횟수
RETRY_DELAY_SECONDS = 8    # 재시도 전 대기
PER_WORKER_DELAY_SECONDS = 2  # 워커 하나가 다음 키워드로 넘어가기 전 대기


def _check_keyword(keyword: str) -> dict:
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            html = fetch_html(keyword, headless=True)
            posts = extract_posts(html)
            return {"keyword": keyword, "posts": posts, "error": None}
        except Exception as e:
            last_error = str(e)
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY_SECONDS)
    return {"keyword": keyword, "posts": [], "error": last_error}


def run_alert_check(monitor: dict, keywords: list[str] | None = None, notify: bool = True, progress_cb=None) -> dict:
    """monitor의 키워드를 2개씩 병렬 확인하고 결과 요약을 반환 + 히스토리에 저장.

    keywords를 따로 주면 monitor['keywords'] 대신 그걸 사용(테스트/부분실행용).
    progress_cb(done, total)이 주어지면 키워드 하나 끝날 때마다 호출된다.
    """
    keywords = keywords if keywords is not None else monitor.get("keywords", [])
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d %H:%M") + " KST"

    total = len(keywords)
    results = []
    if keywords:
        progress_lock = threading.Lock()
        done_count = 0

        def _worker(kw):
            nonlocal done_count
            r = _check_keyword(kw)
            time.sleep(PER_WORKER_DELAY_SECONDS)
            with progress_lock:
                done_count += 1
                if progress_cb:
                    progress_cb(done_count, total)
            return r

        with ThreadPoolExecutor(max_workers=ALERT_WORKERS) as pool:
            results = list(pool.map(_worker, keywords))  # 입력 순서 그대로 반환됨

    summary = {
        "ran_at": date_str,
        "keywords_checked": len(keywords),
        "total_hits": sum(len(r["posts"]) for r in results if not r.get("error")),
        "results": results,
        "notified": False,
        "notify_error": None,
    }

    if notify and keywords:
        webhook_url = resolve_webhook_url(monitor.get("slack_webhook_url", ""))
        if webhook_url:
            try:
                send_slack_digest(monitor["name"], monitor["id"], webhook_url, date_str, results)
                summary["notified"] = True
            except Exception as e:
                summary["notify_error"] = str(e)
        else:
            summary["notify_error"] = "이 모니터에 슬랙 웹훅이 설정되지 않아 전송을 건너뜀"

    monitor_store.append_history(monitor["id"], summary)
    return summary
