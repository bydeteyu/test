"""
감시 키워드 목록 저장소
========================
매일 아침 자동 확인할 키워드를 파일(JSON)에 저장/조회/삭제한다.

DATA_DIR 환경변수로 저장 위치를 바꿀 수 있다. Railway처럼 배포마다
컨테이너 파일시스템이 초기화되는 환경에서는 Volume을 만들어
DATA_DIR을 그 Volume 마운트 경로로 지정해야 목록이 유지된다.
(설정 안 하면 기본값 ./data 는 재배포 시 초기화될 수 있다.)
"""

import json
import os
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
KEYWORDS_FILE = DATA_DIR / "alert_keywords.json"
LAST_RUN_FILE = DATA_DIR / "alert_last_run.json"

_lock = threading.Lock()


def _ensure_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not KEYWORDS_FILE.exists():
        KEYWORDS_FILE.write_text("[]", encoding="utf-8")


def _read() -> list[str]:
    """호출자가 이미 _lock을 잡고 있다고 가정 (내부 전용, 재진입 락 회피)."""
    _ensure_file()
    try:
        return json.loads(KEYWORDS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def list_keywords() -> list[str]:
    with _lock:
        return _read()


def _save(keywords: list[str]):
    KEYWORDS_FILE.write_text(
        json.dumps(keywords, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def add_keyword(keyword: str) -> list[str]:
    keyword = keyword.strip()
    with _lock:
        keywords = _read()
        if keyword and keyword not in keywords:
            keywords.append(keyword)
            _save(keywords)
        return keywords


def remove_keyword(keyword: str) -> list[str]:
    with _lock:
        keywords = [k for k in _read() if k != keyword]
        _save(keywords)
        return keywords


def set_keywords(keywords: list[str]) -> list[str]:
    cleaned = []
    for k in keywords:
        k = k.strip()
        if k and k not in cleaned:
            cleaned.append(k)
    with _lock:
        _ensure_file()
        _save(cleaned)
        return cleaned


def save_last_run(result: dict) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        LAST_RUN_FILE.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def load_last_run() -> dict | None:
    with _lock:
        if not LAST_RUN_FILE.exists():
            return None
        try:
            return json.loads(LAST_RUN_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
