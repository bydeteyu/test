"""
네이버 통합검색 카페글 정리기
================================
입력한 키워드로 네이버 '통합검색'을 열어, 거기 노출되는 카페글만 골라
제목 / 카페이름 / 링크로 깔끔하게 정리한다. (콘솔 출력 + CSV 저장)

키워드는 매번 바뀔 수 있음 → 실행 인자로 받거나, 없으면 직접 입력받는다.

────────────────────────────────────────────────
설치 (최초 1회):
    pip install playwright beautifulsoup4
    playwright install chromium

사용법:
    python naver_cafe_collector.py "수원한방병원 추천"
    python naver_cafe_collector.py "수원한방병원 추천" "수원 교통사고 한의원"   # 여러 개
    python naver_cafe_collector.py                                          # 그냥 실행 → 입력 프롬프트
    python naver_cafe_collector.py "키워드" --sort date --headless
────────────────────────────────────────────────
"""

import re
import csv
import sys
import time
import argparse
from pathlib import Path
from datetime import datetime

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright


# ── 카페글 식별용 URL 패턴 ────────────────────────────────────
# 1) 신형 뷰어:  cafe.naver.com/f-e/cafes/{카페id}/articles/{글id}
ARTICLE_NEW = re.compile(r"cafe\.naver\.com/f-e/cafes/(\d+)/articles/(\d+)")
# 2) 구형:       cafe.naver.com/{슬러그}/{글번호}
ARTICLE_OLD = re.compile(r"cafe\.naver\.com/(?!f-e/)([^/?#]+)/(\d+)")
# 카페 '홈' 링크(글번호 없음) → 카페 이름 후보
CAFE_HOME = re.compile(r"cafe\.naver\.com/(?!f-e/)([^/?#]+)/?(?:[?#]|$)")


def build_url(keyword: str) -> str:
    from urllib.parse import quote
    return f"https://search.naver.com/search.naver?query={quote(keyword)}"


def fetch_html(keyword: str, headless: bool) -> str:
    """통합검색 페이지를 브라우저로 렌더링해서 최종 HTML 반환."""
    LOW_MEM_ARGS = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--js-flags=--max-old-space-size=256",
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, args=LOW_MEM_ARGS)
        page = browser.new_page(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="ko-KR",
        )
        page.goto(build_url(keyword), wait_until="domcontentloaded", timeout=30000)
        for _ in range(3):
            page.mouse.wheel(0, 1500)
            time.sleep(0.6)
        time.sleep(1)
        html = page.content()
        browser.close()
    return html


def clean_title(text: str) -> str:
    """제목 정제: 공백 정리 + 꼬리 말줄임 제거."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[.…]{2,}$", "", text).strip()  # 끝의 ... 제거
    return text


def article_key(href: str):
    """글 식별 키 + 카페슬러그(있으면). 카페글이 아니면 None."""
    m = ARTICLE_NEW.search(href)
    if m:
        return (f"new:{m.group(1)}/{m.group(2)}", None)
    m = ARTICLE_OLD.search(href)
    if m:
        return (f"old:{m.group(1)}/{m.group(2)}", m.group(1))
    return (None, None)


def find_cafe_name(anchor) -> str | None:
    """글 링크의 조상 노드를 거슬러 올라가며 카페 홈 링크(=카페명) 탐색."""
    node = anchor
    for _ in range(7):
        node = node.parent
        if node is None:
            break
        for a in node.find_all("a", href=True):
            if CAFE_HOME.search(a["href"]) and not article_key(a["href"])[0]:
                name = re.sub(r"\s+", " ", a.get_text(strip=True))
                if name:
                    return name
    return None


def extract_posts(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    seen, posts = set(), []

    for a in soup.find_all("a", href=True):
        key, slug = article_key(a["href"])
        if not key:
            continue
        title = clean_title(a.get_text())
        if not title or len(title) < 2:   # 썸네일 등 빈 링크 제외
            continue
        if key in seen:
            continue
        seen.add(key)

        cafe = find_cafe_name(a) or slug or "(확인필요)"
        posts.append({"제목": title, "카페이름": cafe, "링크": a["href"]})

    return posts


def print_table(keyword: str, posts: list[dict]) -> None:
    print(f"\n■ '{keyword}' 통합검색 카페글 — {len(posts)}건")
    print("─" * 60)
    if not posts:
        print("  카페글을 못 찾았습니다.")
        print("  → headless=False로 화면 확인 / 캡차·차단 여부 점검")
        print("─" * 60)
        return
    for i, p in enumerate(posts, 1):
        print(f"{i:>2}. {p['제목']}")
        print(f"    카페: {p['카페이름']}")
        print(f"    링크: {p['링크']}")
    print("─" * 60)


def save_csv(keyword: str, posts: list[dict], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w가-힣]+", "_", keyword).strip("_")
    path = out_dir / f"카페글_{safe}_{datetime.now():%Y%m%d_%H%M}.csv"
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["제목", "카페이름", "링크"])
        w.writeheader()
        w.writerows(posts)
    return path


def get_keywords(args_keywords: list[str]) -> list[str]:
    """인자로 받은 키워드, 없으면 직접 입력받기."""
    if args_keywords:
        return args_keywords
    raw = input("검색할 키워드 입력 (여러 개는 콤마로 구분): ").strip()
    return [k.strip() for k in raw.split(",") if k.strip()]


def main():
    parser = argparse.ArgumentParser(description="네이버 통합검색 카페글 정리기")
    parser.add_argument("keywords", nargs="*", help="검색 키워드 (여러 개 가능)")
    parser.add_argument("--sort", choices=["sim", "date"], default="sim",
                        help="참고용(현재 통합검색은 정렬 고정)")
    parser.add_argument("--headless", action="store_true",
                        help="브라우저 창 숨기고 실행 (차단 시 빼고 다시 시도)")
    parser.add_argument("--out", default="output", help="CSV 저장 폴더")
    args = parser.parse_args()

    keywords = get_keywords(args.keywords)
    if not keywords:
        print("키워드가 없습니다. 종료합니다.")
        sys.exit(1)

    out_dir = Path(args.out)
    for kw in keywords:
        try:
            html = fetch_html(kw, headless=args.headless)
            posts = extract_posts(html)
            print_table(kw, posts)
            if posts:
                path = save_csv(kw, posts, out_dir)
                print(f"저장 완료 → {path}\n")
        except Exception as e:
            print(f"\n[에러] '{kw}' 처리 중 문제 발생: {e}")
            print("→ playwright install chromium 을 했는지, 네트워크/차단 여부 확인\n")


if __name__ == "__main__":
    main()
