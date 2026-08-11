"""슬랙 웹훅으로 일일 카페글 노출 알림을 보낸다."""

import os

import requests

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
APP_BASE_URL = os.environ.get("APP_BASE_URL", "https://test-production-cc54.up.railway.app")


def slack_ready() -> bool:
    return bool(SLACK_WEBHOOK_URL.strip())


def build_digest_text(date_str: str, results: list[dict]) -> str:
    """results: [{'keyword': str, 'posts': [{'제목','카페이름','링크',...}], 'error': str|None}, ...]"""
    total_hits = sum(len(r["posts"]) for r in results if not r.get("error"))
    keywords_url = f"{APP_BASE_URL.rstrip('/')}/keywords"
    lines = [f"*네이버 카페글 노출 알림 ({date_str})*", f"총 {len(results)}개 키워드 확인 · {total_hits}건 노출\n"]

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
            lines.append(f"    …외 {more}건 · <{keywords_url}|전체 보러가기>")
    return "\n".join(lines)


def send_slack_digest(date_str: str, results: list[dict]) -> None:
    if not slack_ready():
        raise RuntimeError("SLACK_WEBHOOK_URL 환경변수가 설정되어 있지 않습니다.")
    text = build_digest_text(date_str, results)
    resp = requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=10)
    resp.raise_for_status()
