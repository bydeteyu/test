"""
Naver Keyword Collector
- 네이버 검색광고 API로 연관키워드·검색량·경쟁도를 수집
- 점수식으로 황금키워드를 자동 선별해 주간 CSV 출력
"""

import csv
import hashlib
import hmac
import os
import time
from base64 import b64encode
from datetime import date
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

# ── 환경변수 ──────────────────────────────────────────────
API_KEY = os.environ.get("NAVER_API_KEY", "")
SECRET_KEY = os.environ.get("NAVER_SECRET_KEY", "")
CUSTOMER_ID = os.environ.get("NAVER_CUSTOMER_ID", "")

BASE_URL = "https://api.naver.com"

# ── 컴플라이언스 감점 목록 (수정 금지) ───────────────────
RISK_TERMS = {"도박", "불법", "성인", "마약", "사기"}

OUTPUT_DIR = Path("output")


# ── 인증 헤더 ────────────────────────────────────────────
def _sign(timestamp: str, method: str, path: str) -> str:
    message = f"{timestamp}.{method}.{path}"
    raw = hmac.new(SECRET_KEY.encode(), message.encode(), hashlib.sha256).digest()
    return b64encode(raw).decode()


def _auth_headers(method: str, path: str) -> dict:
    ts = str(int(time.time() * 1000))
    return {
        "X-Timestamp": ts,
        "X-API-KEY": API_KEY,
        "X-Customer": CUSTOMER_ID,
        "X-Signature": _sign(ts, method, path),
        "Content-Type": "application/json; charset=UTF-8",
    }


# ── API 호출 ─────────────────────────────────────────────
def fetch_related_keywords(seed: str) -> list[dict]:
    path = "/keywordstool"
    params = {"hintKeywords": seed, "showDetail": "1"}
    headers = _auth_headers("GET", path)
    resp = requests.get(BASE_URL + path, headers=headers, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json().get("keywordList", [])


# ── 점수식 ───────────────────────────────────────────────
def score(kw: dict) -> float:
    """
    score = (monthlyPcQcCnt + monthlyMobileQcCnt)
            / (compIdx + 1)
            * competition_penalty
    compIdx: LOW=1, MEDIUM=2, HIGH=3
    """
    pc = float(kw.get("monthlyPcQcCnt", 0))
    mobile = float(kw.get("monthlyMobileQcCnt", 0))
    comp_map = {"낮음": 1, "보통": 2, "높음": 3, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
    comp_idx = comp_map.get(str(kw.get("compIdx", "보통")), 2)

    keyword_text = str(kw.get("relKeyword", ""))
    risk_penalty = 0.0 if any(t in keyword_text for t in RISK_TERMS) else 1.0

    return (pc + mobile) / (comp_idx + 1) * risk_penalty


# ── 메인 파이프라인 ──────────────────────────────────────
def collect(seed_file: str = "seeds.txt") -> list[dict]:
    seeds = Path(seed_file).read_text(encoding="utf-8").splitlines()
    seeds = [s.strip() for s in seeds if s.strip()]

    all_keywords: dict[str, dict] = {}
    for seed in seeds:
        rows = fetch_related_keywords(seed)
        for row in rows:
            kw = row.get("relKeyword", "")
            if kw and kw not in all_keywords:
                all_keywords[kw] = row

    results = []
    for kw, row in all_keywords.items():
        results.append(
            {
                "keyword": kw,
                "pc_volume": row.get("monthlyPcQcCnt", 0),
                "mobile_volume": row.get("monthlyMobileQcCnt", 0),
                "competition": row.get("compIdx", ""),
                "score": round(score(row), 2),
            }
        )

    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def save_csv(results: list[dict], out_dir: Path = OUTPUT_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = out_dir / f"keywords_{date.today().isoformat()}.csv"
    with open(filename, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["keyword", "pc_volume", "mobile_volume", "competition", "score"])
        writer.writeheader()
        writer.writerows(results)
    return filename


if __name__ == "__main__":
    results = collect()
    path = save_csv(results)
    print(f"저장 완료: {path}  ({len(results)}개 키워드)")
