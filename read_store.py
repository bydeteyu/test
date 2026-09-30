"""
읽은 카페글 표시 저장소
========================
사용자가 '확인'한(읽은) 카페글을 URL 기준으로 저장한다. 같은 글이 여러
키워드/모니터에 노출되더라도 URL이 같으면 한 번 확인한 것으로 처리된다.

monitor_store와 동일하게 DATA_DIR(가급적 Railway Volume)에 저장해서 배포·재시작
후에도 유지된다.
"""

import json
import os
import threading
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
READ_FILE = DATA_DIR / "read_marks.json"

_lock = threading.Lock()


def _read() -> dict:
    if not READ_FILE.exists():
        return {}
    try:
        data = json.loads(READ_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write(data: dict):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = READ_FILE.with_suffix(READ_FILE.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, READ_FILE)


def list_marks() -> list[str]:
    """확인 처리된 URL 목록."""
    with _lock:
        return list(_read().keys())


def mark(url: str, title: str = "") -> None:
    url = (url or "").strip()
    if not url:
        return
    with _lock:
        data = _read()
        data[url] = {
            "title": (title or "").strip(),
            "read_at": datetime.now().isoformat(timespec="seconds"),
        }
        _write(data)


def unmark(url: str) -> None:
    url = (url or "").strip()
    if not url:
        return
    with _lock:
        data = _read()
        if url in data:
            del data[url]
            _write(data)
