"""
써큐톡스 황금 키워드 리서치 대시보드
FastAPI + SSE 실시간 진행 스트림
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
from fastapi.staticfiles import StaticFiles
import jinja2
import markdown2
from dotenv import load_dotenv

# 프로젝트 루트를 path에 추가
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

_jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(Path(__file__).parent / "templates")),
    autoescape=True,
)
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")

OUTPUT_DIR = ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True)
CACHE_DIR = ROOT / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

# 진행 중인 작업 관리
_jobs: dict[str, dict] = {}  # job_id → {status, queue, result_path}

# 메모리 내 리포트 캐시 (Railway 파일시스템 휘발성 대비)
_report_cache: dict[str, str] = {}  # date_str → markdown content


# ── 파이프라인 실행 (별도 스레드) ────────────────────────────────────────────

class QueueHandler(logging.Handler):
    """로그를 SSE 큐에 전달."""
    def __init__(self, q: queue.Queue):
        super().__init__()
        self.q = q

    def emit(self, record):
        msg = self.format(record)
        level = record.levelname
        self.q.put({"type": "log", "level": level, "msg": msg})


def _run_pipeline(job_id: str, keywords: list[str], use_cache: bool):
    """파이프라인을 별도 스레드에서 실행, 진행 상황을 큐에 넣음."""
    q = _jobs[job_id]["queue"]

    def emit(step: str, msg: str, pct: int):
        q.put({"type": "progress", "step": step, "msg": msg, "pct": pct})

    # 로거 큐 핸들러 연결
    root_logger = logging.getLogger()
    handler = QueueHandler(q)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)

    try:
        today = datetime.today()
        config_dir = ROOT / "config"
        cafes = json.loads((config_dir / "cafes.json").read_text(encoding="utf-8"))["cafes"]
        channels = json.loads((config_dir / "channels.json").read_text(encoding="utf-8"))["youtube_channels"]

        # ── Step 1. 수집 ──────────────────────────────────────────
        emit("collect", "소스 A — 네이버 카페 수집 시작", 5)
        cache_path = CACHE_DIR / f"{today.strftime('%Y-%m-%d')}_raw.json"

        if use_cache and cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            cafe_posts = cached.get("cafe_posts", [])
            trends = cached.get("trends", {})
            videos = cached.get("videos", [])
            emit("collect", f"캐시 재사용 — 카페 {len(cafe_posts)}건, 트렌드 {len(trends)}개", 25)
        else:
            try:
                cafe_posts = collect_all_cafes(keywords, cafes)
            except Exception as e:
                cafe_posts = []
                emit("collect", f"카페 수집 실패 (계속 진행): {e}", 15)

            emit("collect", f"소스 B — 데이터랩 수집 시작 (키워드 {len(keywords)}개)", 20)
            try:
                trends = collect_search_trends(keywords)
            except Exception as e:
                trends = {}
                emit("collect", f"데이터랩 실패 (계속 진행): {e}", 22)

            emit("collect", "소스 C — 유튜브 채널 수집 시작", 23)
            try:
                videos = collect_youtube_trends(channels)
            except Exception as e:
                videos = []
                emit("collect", f"유튜브 실패 (계속 진행): {e}", 24)

            cache_path.write_text(
                json.dumps({"cafe_posts": cafe_posts, "trends": trends, "videos": videos},
                           ensure_ascii=False),
                encoding="utf-8",
            )

        emit("collect", f"수집 완료 — 카페 {len(cafe_posts)}건 · 트렌드 {len(trends)}개 · 영상 {len(videos)}개", 30)

        # ── Step 2. 분석 ──────────────────────────────────────────
        emit("analyze", "키워드 빈도 분석 중…", 35)
        analysis = analyze_cafe_posts(cafe_posts)
        seasonal = load_seasonal_signals(today.month)
        emit("analyze", f"분석 완료 — 빈출 키워드 {len(analysis.get('top_keywords',[]))}개, 페인 게시글 {len(analysis.get('pain_posts',[]))}건", 50)

        # ── Step 3. 제목 생성 ─────────────────────────────────────
        emit("generate", "Claude AI로 황금 제목 생성 중… (30초~1분 소요)", 55)
        generated = generate_golden_titles(analysis, trends, videos, seasonal)
        top3 = generated.get("top3", [])
        emit("generate", f"제목 생성 완료 — TOP {len(top3)}개", 80)

        # ── Step 4. 리포트 ────────────────────────────────────────
        emit("report", "마크다운 리포트 생성 중…", 85)
        out_path = render_report(generated, analysis, trends, videos, seasonal, today)
        emit("report", f"리포트 저장: {out_path.name}", 95)

        # 메모리 캐시에도 저장 (클라우드 환경 대비)
        _report_cache[today.strftime("%Y-%m-%d")] = out_path.read_text(encoding="utf-8")

        _jobs[job_id]["result_path"] = str(out_path)
        _jobs[job_id]["status"] = "done"
        _jobs[job_id]["generated"] = generated
        _jobs[job_id]["analysis"] = analysis
        _jobs[job_id]["trends"] = trends
        _jobs[job_id]["videos"] = videos
        _jobs[job_id]["seasonal"] = seasonal

        q.put({"type": "done", "path": out_path.name, "pct": 100,
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
    reports = sorted(OUTPUT_DIR.glob("*.md"), reverse=True)
    history = [p.stem for p in reports if p.stem != ".gitkeep"][:30]
    tmpl = _jinja_env.get_template("index.html")
    return HTMLResponse(tmpl.render(history=history))


@app.post("/api/run")
async def run_pipeline(request: Request):
    body = await request.json()
    keywords = body.get("keywords", [])
    use_cache = body.get("use_cache", False)

    if not keywords:
        # 기본 시드 키워드 사용
        config = json.loads((ROOT / "config" / "seeds.json").read_text(encoding="utf-8"))
        keywords = config["seed_keywords"]

    job_id = datetime.now().strftime("%Y%m%d%H%M%S")
    _jobs[job_id] = {
        "status": "running",
        "queue": queue.Queue(),
        "result_path": None,
        "keywords": keywords,
    }

    t = threading.Thread(target=_run_pipeline, args=(job_id, keywords, use_cache), daemon=True)
    t.start()

    return JSONResponse({"job_id": job_id})


@app.get("/api/stream/{job_id}")
async def stream(job_id: str):
    """SSE 스트림 — 파이프라인 진행 상황 실시간 전송."""
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
                yield "data: {\"type\":\"heartbeat\"}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/report/{date_str}")
async def get_report(date_str: str):
    """마크다운 리포트를 HTML로 변환해서 반환."""
    # 파일 먼저, 없으면 메모리 캐시
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
    uvicorn.run("web.app:app", host="0.0.0.0", port=8000, reload=True)
