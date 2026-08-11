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
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI",
        "--js-flags=--max-old-space-size=512",
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, args=LOW_MEM_ARGS)
        try:
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
            return page.content()
        finally:
            # goto/wheel 중 예외가 나도 브라우저 프로세스가 남지 않도록 항상 정리한다.
            browser.close()


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


# "새 창 열림" 같은 스크린리더 전용 안내 문구가 카페명/제목에 섞여 나올 수
# 있다. 별도 .blind 태그로 감싸져 있으면 decompose로 제거되지만, 그냥 텍스트
# 뒤에 이어붙어 나오는 경우도 있어 문자열 어디에 있든 제거해야 한다.
HIDDEN_LABEL_RE = re.compile(r"새\s*창\s*열림|동영상\s*재생|바로가기|더보기")


def _anchor_visible_text(a) -> str:
    """앵커의 보이는 텍스트만 추출한다 (.blind 등 숨김 라벨 + 알려진 안내 문구 제외)."""
    clone = BeautifulSoup(str(a), "html.parser")
    for hidden in clone.select(".blind, [aria-hidden='true']"):
        hidden.decompose()
    text = clone.get_text(" ", strip=True)
    text = HIDDEN_LABEL_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def find_cafe_info(anchor):
    """글 링크 조상을 거슬러 카페 홈 링크에서 (카페명, 슬러그) 반환."""
    node = anchor
    for _ in range(7):
        node = node.parent
        if node is None:
            break
        for a in node.find_all("a", href=True):
            m = CAFE_HOME.search(a["href"])
            if m and not article_key(a["href"])[0]:
                name = _anchor_visible_text(a)
                if not name:
                    continue
                slug = m.group(1)
                if name and slug:
                    return name, slug
    return None, None


# 검색결과에 나타나는 작성일 형태:
#   2024.05.01. / 2024.05.01 / 3일 전 / 1시간 전 / 2주 전 / 어제 / 방금 전
_DATE_RE = re.compile(
    r"(\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?"    # 2024.05.01. (연도 포함 정식 날짜)
    r"|(?:방금|어제|그저께)\s*전?"
    r"|\d+\s*(?:분|시간|일|주|개월|달|년)\s*전)"  # 3일 전, 2주 전 …
)


def find_date(anchor):
    """글 링크 주변(조상)에서 작성일/상대시간 텍스트를 찾아 반환."""
    node = anchor
    for _ in range(6):
        node = node.parent
        if node is None:
            break
        # 날짜는 보통 짧은 span/em 안에 있음 → 텍스트 전체에서 패턴 검색
        text = node.get_text(" ", strip=True)
        m = _DATE_RE.search(text)
        if m:
            return m.group(1).strip()
    return ""


def make_canonical_url(href: str, slug: str, article_id: str) -> str:
    """'URL 복사' 형태: https://cafe.naver.com/{슬러그}/{글번호}"""
    if slug and article_id:
        return f"https://cafe.naver.com/{slug}/{article_id}"
    return href if href.startswith("http") else "https://" + href


def extract_posts(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    seen, posts = set(), []

    for a in soup.find_all("a", href=True):
        key, slug_from_url = article_key(a["href"])
        if not key:
            continue
        title = clean_title(_anchor_visible_text(a))
        if not title or len(title) < 2:
            continue
        if key in seen:
            continue
        seen.add(key)

        cafe_name, cafe_slug = find_cafe_info(a)

        # 슬러그 결정: 구형 URL에서 직접 추출 or 카페 홈 링크에서 추출
        slug = slug_from_url or cafe_slug or ""
        # 글 번호 추출
        m_new = ARTICLE_NEW.search(a["href"])
        m_old = ARTICLE_OLD.search(a["href"])
        article_id = m_new.group(2) if m_new else (m_old.group(2) if m_old else "")

        canonical = make_canonical_url(a["href"], slug, article_id)
        cafe = cafe_name or slug or "(확인필요)"
        date = find_date(a)
        posts.append({"제목": title, "카페이름": cafe, "작성일": date, "링크": canonical})

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
        w = csv.DictWriter(f, fieldnames=["제목", "카페이름", "작성일", "링크"], extrasaction="ignore")
        w.writeheader()
        w.writerows(posts)
    return path


def save_excel_combined(results: list[dict], out_dir: Path) -> Path:
    """모든 키워드 결과를 시트 하나짜리 엑셀로 저장. 키워드 열 포함."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"카페글_수집_{datetime.now():%Y%m%d_%H%M}.xlsx"

    wb = Workbook()
    ws = wb.active
    ws.title = "수집결과"

    headers = ["키워드", "제목", "카페이름", "작성일", "링크"]
    header_fill = PatternFill("solid", fgColor="1a6e3c")
    header_font = Font(bold=True, color="FFFFFF")

    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    row = 2
    for r in results:
        kw = r["keyword"]
        for p in r["posts"]:
            ws.cell(row=row, column=1, value=kw)
            ws.cell(row=row, column=2, value=p["제목"])
            ws.cell(row=row, column=3, value=p["카페이름"])
            ws.cell(row=row, column=4, value=p.get("작성일", ""))
            # 링크는 하이퍼링크로
            cell = ws.cell(row=row, column=5, value=p["링크"])
            cell.hyperlink = p["링크"]
            cell.font = Font(color="1565C0", underline="single")
            row += 1

    # 열 너비 자동 조정
    col_widths = [20, 50, 30, 16, 60]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    wb.save(path)
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
