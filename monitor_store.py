"""
카페글 노출 알림 — 다중 모니터 저장소
========================================
"모니터"는 (이름 + 감시 키워드 목록 + 전송할 슬랙 웹훅 + 실행 히스토리)의
묶음이다. 하나의 서비스 안에서 여러 개(예: 사업장별로 하나씩)를 독립적으로
운영할 수 있다.

DATA_DIR 환경변수로 저장 위치를 바꿀 수 있다. Railway처럼 배포마다
컨테이너 파일시스템이 초기화되는 환경에서는 Volume을 만들어
DATA_DIR을 그 Volume 마운트 경로로 지정해야 데이터가 유지된다.

주의: 모니터별 슬랙 웹훅 URL은 (개수 제한이 없어 환경변수로는 관리할 수
없으므로) 이 데이터 파일에 평문으로 저장된다. DATA_DIR을 가리키는 Volume은
외부에 공개되지 않는 내부 저장소이지만, 완전한 비밀값 취급(예: Vault)은
아니라는 점을 감안한다.

레거시 마이그레이션: 이 모듈 이전 버전(alert_store.py)은 모니터 개념 없이
키워드 목록 하나와 마지막 실행 결과 하나만 저장했다. 그 파일들
(alert_keywords.json, alert_last_run.json)이 남아 있고 아직 monitors.json이
없으면, 최초 접근 시 "모니터 1"로 자동 변환해 데이터를 보존한다.
"""

import json
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
MONITORS_FILE = DATA_DIR / "monitors.json"
HISTORY_DIR = DATA_DIR / "monitor_history"

# 레거시(단일 모니터 시절) 파일 — 마이그레이션에만 사용
LEGACY_KEYWORDS_FILE = DATA_DIR / "alert_keywords.json"
LEGACY_LAST_RUN_FILE = DATA_DIR / "alert_last_run.json"

MAX_HISTORY = 30

_lock = threading.Lock()


def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _migrate_legacy_if_needed():
    """구버전 단일 키워드 목록을 '모니터 1'로 1회 변환."""
    if MONITORS_FILE.exists() or not LEGACY_KEYWORDS_FILE.exists():
        return
    try:
        legacy_keywords = json.loads(LEGACY_KEYWORDS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        legacy_keywords = []

    monitor = {
        "id": uuid.uuid4().hex[:12],
        "name": "모니터 1",
        "slack_webhook_url": "",  # 비어있으면 전역 SLACK_WEBHOOK_URL로 폴백 (기존 동작 유지)
        "keywords": legacy_keywords,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    _write_monitors([monitor])

    if LEGACY_LAST_RUN_FILE.exists():
        try:
            last_run = json.loads(LEGACY_LAST_RUN_FILE.read_text(encoding="utf-8"))
            _write_history(monitor["id"], [last_run])
        except (json.JSONDecodeError, OSError):
            pass


def _read_monitors() -> list[dict]:
    _ensure_dirs()
    _migrate_legacy_if_needed()
    if not MONITORS_FILE.exists():
        return []
    try:
        return json.loads(MONITORS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _write_monitors(monitors: list[dict]):
    _ensure_dirs()
    MONITORS_FILE.write_text(json.dumps(monitors, ensure_ascii=False, indent=2), encoding="utf-8")


def list_monitors() -> list[dict]:
    with _lock:
        return _read_monitors()


def get_monitor(monitor_id: str) -> dict | None:
    with _lock:
        for m in _read_monitors():
            if m["id"] == monitor_id:
                return m
        return None


def create_monitor(name: str, slack_webhook_url: str = "") -> dict:
    name = name.strip() or "새 모니터"
    monitor = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "slack_webhook_url": slack_webhook_url.strip(),
        "keywords": [],
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    with _lock:
        monitors = _read_monitors()
        monitors.append(monitor)
        _write_monitors(monitors)
    return monitor


def update_monitor(monitor_id: str, name: str | None = None, slack_webhook_url: str | None = None) -> dict | None:
    with _lock:
        monitors = _read_monitors()
        updated = None
        for m in monitors:
            if m["id"] == monitor_id:
                if name is not None and name.strip():
                    m["name"] = name.strip()
                if slack_webhook_url is not None:
                    m["slack_webhook_url"] = slack_webhook_url.strip()
                updated = m
                break
        if updated:
            _write_monitors(monitors)
        return updated


def delete_monitor(monitor_id: str) -> None:
    with _lock:
        monitors = [m for m in _read_monitors() if m["id"] != monitor_id]
        _write_monitors(monitors)
    history_file = HISTORY_DIR / f"{monitor_id}.json"
    if history_file.exists():
        history_file.unlink()


def add_keyword(monitor_id: str, keyword: str) -> list[str] | None:
    keyword = keyword.strip()
    with _lock:
        monitors = _read_monitors()
        for m in monitors:
            if m["id"] == monitor_id:
                if keyword and keyword not in m["keywords"]:
                    m["keywords"].append(keyword)
                    _write_monitors(monitors)
                return m["keywords"]
        return None


def add_keywords(monitor_id: str, new_keywords: list[str]) -> list[str] | None:
    with _lock:
        monitors = _read_monitors()
        for m in monitors:
            if m["id"] == monitor_id:
                existing = set(m["keywords"])
                for k in new_keywords:
                    k = k.strip()
                    if k and k not in existing:
                        m["keywords"].append(k)
                        existing.add(k)
                _write_monitors(monitors)
                return m["keywords"]
        return None


def remove_keyword(monitor_id: str, keyword: str) -> list[str] | None:
    with _lock:
        monitors = _read_monitors()
        for m in monitors:
            if m["id"] == monitor_id:
                m["keywords"] = [k for k in m["keywords"] if k != keyword]
                _write_monitors(monitors)
                return m["keywords"]
        return None


def _history_file(monitor_id: str) -> Path:
    return HISTORY_DIR / f"{monitor_id}.json"


def _read_history(monitor_id: str) -> list[dict]:
    f = _history_file(monitor_id)
    if not f.exists():
        return []
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _write_history(monitor_id: str, history: list[dict]):
    _ensure_dirs()
    _history_file(monitor_id).write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def append_history(monitor_id: str, run_summary: dict) -> None:
    """실행 결과를 히스토리 맨 뒤에 추가하고 오래된 기록은 MAX_HISTORY개만 남긴다."""
    with _lock:
        history = _read_history(monitor_id)
        history.append(run_summary)
        if len(history) > MAX_HISTORY:
            history = history[-MAX_HISTORY:]
        _write_history(monitor_id, history)


def get_history(monitor_id: str) -> list[dict]:
    """최신 실행이 먼저 오도록 반환."""
    with _lock:
        return list(reversed(_read_history(monitor_id)))


def get_latest_run(monitor_id: str) -> dict | None:
    with _lock:
        history = _read_history(monitor_id)
        return history[-1] if history else None
