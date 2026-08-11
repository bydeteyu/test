"""슬랙 웹훅으로 카페글 노출 알림을 보낸다. 모니터마다 자기 웹훅을 쓸 수 있다."""

import os

import requests

# 모니터에 자기 웹훅이 설정되어 있지 않으면 이 전역 값으로 폴백한다
# (구버전 단일 모니터 시절 데이터와의 호환을 위해 유지).
DEFAULT_SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
APP_BASE_URL = os.environ.get("APP_BASE_URL", "https://test-production-cc54.up.railway.app")


def resolve_webhook_url(monitor_webhook_url: str) -> str:
    return (monitor_webhook_url or "").strip() or DEFAULT_SLACK_WEBHOOK_URL


def build_digest_text(monitor_name: str, monitor_id: str, date_str: str, results: list[dict]) -> str:
    """results: [{'keyword': str, 'posts': [{'제목','카페이름','링크',...}], 'error': str|None}, ...]"""
    total_hits = sum(len(r["posts"]) for r in results if not r.get("error"))
    monitor_url = f"{APP_BASE_URL.rstrip('/')}/keywords?monitor={monitor_id}"
    lines = [
        f"*[{monitor_name}] 네이버 카페글 노출 알림 ({date_str})*",
        f"총 {len(results)}개 키워드 확인 · {total_hits}건 노출\n",
    ]

    for r in results:
        kw = r["keyword"]
        if r.get("error"):
            lines.append(f"⚠️ *{kw}* — 확인 실패: {r['error']}")
            continue
        posts = r["posts"]
        if not posts:
            lines.append(f"⬜ *{kw}* — 통합검색 노출 없음")
            continue
        lines.append(f"✅ *{kw}* — {len(posts)}건 노출")
        for p in posts[:5]:
            lines.append(f"    • <{p['링크']}|{p['제목']}> ({p['카페이름']})")
        if len(posts) > 5:
            more = len(posts) - 5
            lines.append(f"    …외 {more}건 · <{monitor_url}|전체 보러가기>")
    return "\n".join(lines)


def send_slack_digest(monitor_name: str, monitor_id: str, monitor_webhook_url: str, date_str: str, results: list[dict]) -> None:
    webhook_url = resolve_webhook_url(monitor_webhook_url)
    if not webhook_url:
        raise RuntimeError("이 모니터에 슬랙 웹훅이 설정되어 있지 않고, 기본 SLACK_WEBHOOK_URL도 없습니다.")
    text = build_digest_text(monitor_name, monitor_id, date_str, results)
    resp = requests.post(webhook_url, json={"text": text}, timeout=10)
    resp.raise_for_status()
