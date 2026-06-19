#!/usr/bin/env python3
"""
Flask 웹 서버 - 키워드 리서치 대시보드
"""

import json
import queue
import threading
import time
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

from keyword_pipeline.step1_keywordstool import fetch_related_keywords
from keyword_pipeline.step2_datalab import fetch_trends
from keyword_pipeline.step3_scoring import score_keywords
from keyword_pipeline.step4_ai_expansion import expand_keywords

load_dotenv()

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# 진행 중인 작업 결과를 잡시 저장
_job_store: dict[str, dict] = {}


# ── 파이프라인 ──────────────────────────────────────────────────────────────

def _run_pipeline(job_id: str, seeds: list[str], q: queue.Queue) -> None:
    def emit(step: int, message: str, data=None):
        q.put({"step": step, "message": message, "data": data})

    try:
        emit(1, f"연관 키워드 수집 중... (시드: {', '.join(seeds)})")
        all_kws: list[dict] = []
        for seed in seeds:
            all_kws.extend(fetch_related_keywords(seed))

        seen: set[str] = set()
        unique: list[dict] = []
        for kw in all_kws:
            if kw["keyword"] not in seen:
                seen.add(kw["keyword"])
                unique.append(kw)

        emit(1, f"연관 키워드 {len(unique)}개 수집 완료", {"count": len(unique)})

        emit(2, "트렌드 데이터 수집 중...")
        trend_data = fetch_trends([k["keyword"] for k in unique])
        emit(2, f"트렌드 {len(trend_data)}개 수집 완료", {"count": len(trend_data)})

        emit(3, "기회 점수 계산 중...")
        scored = score_keywords(unique, trend_data)
        emit(3, "점수화 완료")

        emit(4, "AI 검색 대응 키워드 확장 중...")
        expanded = expand_keywords(scored, top_n=20)
        emit(4, "확장 완료")

        # 결과 직렬화
        result = {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "seeds": seeds,
            "total": len(scored),
            "keywords": [
                {
                    "rank": i + 1,
                    "keyword": r["keyword"],
                    "monthly_total": r["monthly_total"],
                    "monthly_pc": r["monthly_pc"],
                    "monthly_mobile": r["monthly_mobile"],
                    "comp_idx": r.get("comp_idx", ""),
                    "trend_label": r.get("trend_label", ""),
                    "opportunity_score": r["opportunity_score"],
                    "question_variants": r.get("question_variants", []),
                    "longtail_variants": r.get("longtail_variants", []),
                }
                for i, r in enumerate(expanded)
            ],
            "all_scored": [
                {
                    "keyword": r["keyword"],
                    "monthly_total": r["monthly_total"],
                    "comp_idx": r.get("comp_idx", ""),
                    "trend_label": r.get("trend_label", ""),
                    "opportunity_score": r["opportunity_score"],
                }
                for r in scored
            ],
        }
        _job_store[job_id] = result
        emit(5, "완료", result)

    except Exception as exc:  # noqa: BLE001
        emit(-1, f"오류 발생: {exc}")


# ── 라우트 ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/research")
def research():
    """SSE 엔드포인트 — 실시간 진행 상황 스트리밍"""
    seeds_raw = request.args.get("keywords", "").strip()
    if not seeds_raw:
        return jsonify({"error": "keywords 파라미터가 필요합니다."}), 400

    seeds = [s.strip() for s in seeds_raw.split(",") if s.strip()]
    job_id = f"{int(time.time() * 1000)}"
    q: queue.Queue = queue.Queue()

    thread = threading.Thread(
        target=_run_pipeline, args=(job_id, seeds, q), daemon=True
    )
    thread.start()

    def stream():
        while True:
            try:
                event = q.get(timeout=60)
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("step") in (5, -1):
                    break
            except queue.Empty:
                yield "data: {\"step\": -1, \"message\": \"타임아웃\"}\n\n"
                break

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/result/<job_id>")
def get_result(job_id: str):
    result = _job_store.get(job_id)
    if not result:
        return jsonify({"error": "결과를 찾을 수 없습니다."}), 404
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
