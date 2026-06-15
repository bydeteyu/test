"""
써큐톡스 황금 키워드 리서치 대시보드
FastAPI — Vercel(서버리스) + 로컬 겸용
"""

import asyncio
import json
import logging
import os
import sys
import threading
import queue
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
import jinja2
import markdown2
from dotenv import load_dotenv

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from src.collect.naver_cafe import collect_all_cafes
from src.collect.datalab import collect_search_trends
from src.collect.youtube import collect_youtube_trends
from src.analyze.keywords import analyze_cafe_posts
from src.analyze.scorer import load_seasonal_signals
from src.generate.titles import generate_golden_titles
from src.report.renderer import render_report

app = FastAPI(title="써큐톡스 키워드 리서치 대시보드")

# Static 파일: 로컬에서는 mount, Vercel에서는 vercel.json routes로 처리
try:
    from fastapi.staticfiles import StaticFiles
    _static_dir = Path(__file__).parent / "static"
    if _static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")
except Exception:
    pass

_jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(Path(__file__).parent / "templates")),
    autoescape=True,
)

OUTPUT_DIR = ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True, parents=True)
CACHE_DIR = ROOT / ".cache"
CACHE_DIR.mkdir(exist_ok=True, parents=True)

_jobs: dict[str, dict] = {}
_report_cache: dict[str, str] = {}  # 메모리 리포트 캐시 (서버리스 대비)


# ── 파이프라인 ────────────────────────────────────────────────────────────────

def _load_seed_keywords(custom: list[str]) -> list[str]:
    if custom:
        return custom
    cfg = json.loads((ROOT / "config" / "seeds.json").read_text(encoding="utf-8"))
    return cfg["seed_keywords"]


def _execute_pipeline(keywords: list[str], use_cache: bool, progress_cb=None) -> dict:
    """
    파이프라인 실행. progress_cb(step, msg, pct) 콜백으로 진행 알림.
    반환값: {date_str, md_content, generated, analysis}
    """
    def emit(step, msg, pct):
        logging.info("[%s] %s", step, msg)
        if progress_cb:
            progress_cb(step, msg, pct)

    today = datetime.today()
    config_dir = ROOT / "config"
    cafes = json.loads((config_dir / "cafes.json").read_text(encoding="utf-8"))["cafes"]
    channels = json.loads((config_dir / "channels.json").read_text(encoding="utf-8"))["youtube_channels"]

    cache_path = CACHE_DIR / f"{today.strftime('%Y-%m-%d')}_raw.json"

    # Step 1. 수집
    emit("collect", "네이버 카페 수집 시작…", 5)
    if use_cache and cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        cafe_posts = cached.get("cafe_posts", [])
        trends = cached.get("trends", {})
        videos = cached.get("videos", [])
        emit("collect", f"캐시 재사용 — {len(cafe_posts)}건", 25)
    else:
        try:
            cafe_posts = collect_all_cafes(keywords, cafes)
        except Exception as e:
            cafe_posts = []
            emit("collect", f"카페 수집 실패 (계속): {e}", 15)

        emit("collect", "데이터랩 수집…", 20)
        try:
            trends = collect_search_trends(keywords)
        except Exception:
            trends = {}

        emit("collect", "유튜브 수집…", 23)
        try:
            videos = collect_youtube_trends(channels)
        except Exception:
            videos = []

        try:
            cache_path.write_text(
                json.dumps({"cafe_posts": cafe_posts, "trends": trends, "videos": videos},
                           ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    emit("collect", f"수집 완료 — 카페 {len(cafe_posts)}건", 30)

    # Step 2. 분석
    emit("analyze", "키워드 분석 중…", 40)
    analysis = analyze_cafe_posts(cafe_posts)
    seasonal = load_seasonal_signals(today.month)
    emit("analyze", "분석 완료", 55)

    # Step 3. 제목 생성
    emit("generate", "Claude AI 황금 제목 생성 중…", 60)
    generated = generate_golden_titles(analysis, trends, videos, seasonal)
    emit("generate", f"제목 {len(generated.get('top3',[]))}개 생성 완료", 80)

    # Step 4. 리포트
    emit("report", "리포트 저장 중…", 88)
    out_path = render_report(generated, analysis, trends, videos, seasonal, today)
    md_content = out_path.read_text(encoding="utf-8")
    date_str = today.strftime("%Y-%m-%d")
    _report_cache[date_str] = md_content
    emit("report", "완료!", 100)

    return {"date_str": date_str, "md_content": md_content,
            "generated": generated, "analysis": analysis}


# ── SSE 방식 (스레드 기반 — 로컬/Railway) ────────────────────────────────────

class _QueueHandler(logging.Handler):
    def __init__(self, q):
        super().__init__()
        self.q = q
    def emit(self, record):
        self.q.put({"type": "log", "level": record.levelname,
                    "msg": self.format(record)})


def _run_in_thread(job_id: str, keywords: list[str], use_cache: bool):
    q = _jobs[job_id]["queue"]
    root_logger = logging.getLogger()
    handler = _QueueHandler(q)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root_logger.addHandler(handler)

    def progress_cb(step, msg, pct):
        q.put({"type": "progress", "step": step, "msg": msg, "pct": pct})

    try:
        result = _execute_pipeline(keywords, use_cache, progress_cb)
        _jobs[job_id]["status"] = "done"
        _jobs[job_id]["date_str"] = result["date_str"]
        top3 = result["generated"].get("top3", [])
        q.put({"type": "done", "path": result["date_str"] + ".md",
               "date_str": result["date_str"], "pct": 100,
               "top3": [t.get("title") for t in top3]})
    except Exception as e:
        logging.exception("파이프라인 오류")
        _jobs[job_id]["status"] = "error"
        q.put({"type": "error", "msg": str(e)})
    finally:
        root_logger.removeHandler(handler)


# ── API 엔드포인트 ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    file_dates = {p.stem for p in OUTPUT_DIR.glob("*.md") if p.stem != ".gitkeep"}
    history = sorted(file_dates | set(_report_cache.keys()), reverse=True)[:30]
    tmpl = _jinja_env.get_template("index.html")
    return HTMLResponse(tmpl.render(history=history))


@app.post("/api/run")
async def run_pipeline(request: Request):
    """비동기 실행 — SSE /api/stream/{job_id} 로 진행 수신."""
    body = await request.json()
    keywords = _load_seed_keywords(body.get("keywords", []))
    use_cache = body.get("use_cache", False)

    job_id = datetime.now().strftime("%Y%m%d%H%M%S")
    _jobs[job_id] = {"status": "running", "queue": queue.Queue()}

    t = threading.Thread(target=_run_in_thread, args=(job_id, keywords, use_cache), daemon=True)
    t.start()
    return JSONResponse({"job_id": job_id})


@app.post("/api/run-sync")
async def run_pipeline_sync(request: Request):
    """
    동기 실행 — Vercel 서버리스 호환 (maxDuration 300s).
    완료 후 결과 한 번에 반환.
    """
    body = await request.json()
    keywords = _load_seed_keywords(body.get("keywords", []))
    use_cache = body.get("use_cache", False)

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: _execute_pipeline(keywords, use_cache)
        )
        html = markdown2.markdown(result["md_content"], extras=["tables", "fenced-code-blocks"])
        return JSONResponse({
            "status": "done",
            "date_str": result["date_str"],
            "html": html,
            "raw": result["md_content"],
            "top3": [t.get("title") for t in result["generated"].get("top3", [])],
        })
    except Exception as e:
        logging.exception("sync pipeline error")
        return JSONResponse({"status": "error", "msg": str(e)}, status_code=500)


@app.get("/api/stream/{job_id}")
async def stream(job_id: str):
    if job_id not in _jobs:
        return JSONResponse({"error": "job not found"}, status_code=404)

    async def event_generator():
        q = _jobs[job_id]["queue"]
        while True:
            try:
                event = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: q.get(timeout=120)
                )
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["type"] in ("done", "error"):
                    break
            except queue.Empty:
                yield 'data: {"type":"heartbeat"}\n\n'

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/report/{date_str}")
async def get_report(date_str: str):
    path = OUTPUT_DIR / f"{date_str}.md"
    if path.exists():
        md = path.read_text(encoding="utf-8")
    elif date_str in _report_cache:
        md = _report_cache[date_str]
    else:
        return JSONResponse({"error": "리포트 없음"}, status_code=404)

    html = markdown2.markdown(md, extras=["tables", "fenced-code-blocks"])
    return JSONResponse({"html": html, "raw": md})


@app.get("/api/reports")
async def list_reports():
    file_dates = {p.stem for p in OUTPUT_DIR.glob("*.md") if p.stem != ".gitkeep"}
    all_dates = sorted(file_dates | set(_report_cache.keys()), reverse=True)
    return JSONResponse({"reports": all_dates})


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("web.app:app", host="0.0.0.0", port=port, reload=False)
