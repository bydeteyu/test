"""
카페글 노출 체크 (모니터별)
============================
모니터의 감시 키워드 목록을 순회하며 네이버 통합검색에서 카페글이
노출되는지 확인(naver_cafe_collector 재사용)하고, 결과를 그 모니터의
슬랙 웹훅으로 보낸 뒤 실행 결과를 히스토리에 남긴다(monitor_store,
최근 30회 보관 — 매번 덮어쓰지 않는다).

속도보다 안정성 우선: 키워드를 동시에 여러 개 처리하지 않고 하나씩
순차 처리한다. 브라우저 인스턴스를 동시에 여러 개 띄우면(Railway의
저메모리 인스턴스에서) 메모리 부족으로 죽을 위험이 커지고, 네이버
쪽에서 짧은 시간에 몰린 요청을 차단할 위험도 커지기 때문. 키워드가
많으면 그만큼 전체 실행 시간이 길어지는 건 감수한다. 일시적인 실패는
바로 포기하지 않고 재시도한다. 모니터는 각자 자기 스케줄(app.py에
모니터별 cron job으로 등록됨)에 맞춰 따로 실행되지만, 두 모니터의
스케줄이 겹치더라도 실제로 동시에 돌지 않도록 app.py 쪽에서 전역
락으로 직렬화한다.

주의: '통합검색'에서 실제로 노출되는 카페글만 뽑는 것이지, 블로그/뉴스
등과 뒤섞인 정확한 '몇 번째 노출'인지까지는 계산하지 않는다 — 노출
여부/목록 확인이 목적이다.
"""

import time
from datetime import datetime
from zoneinfo import ZoneInfo

import monitor_store
from alert_notifier import send_slack_digest, resolve_webhook_url
from naver_cafe_collector import extract_posts, fetch_html

KST = ZoneInfo("Asia/Seoul")

MAX_ATTEMPTS = 3           # 키워드 하나당 최대 시도 횟수
RETRY_DELAY_SECONDS = 8    # 재시도 전 대기
BETWEEN_KEYWORD_DELAY_SECONDS = 3   # 키워드 사이 대기 (네이버 차단/서버 부하 방지)


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
    """monitor의 키워드를 하나씩 순차 확인하고 결과 요약을 반환 + 히스토리에 저장.

    keywords를 따로 주면 monitor['keywords'] 대신 그걸 사용(테스트/부분실행용).
    progress_cb(done, total)이 주어지면 키워드 하나 끝날 때마다 호출된다.
    """
    keywords = keywords if keywords is not None else monitor.get("keywords", [])
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d %H:%M") + " KST"

    results = []
    total = len(keywords)
    for i, kw in enumerate(keywords):
        results.append(_check_keyword(kw))
        if progress_cb:
            progress_cb(i + 1, total)
        if i < total - 1:
            time.sleep(BETWEEN_KEYWORD_DELAY_SECONDS)

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
