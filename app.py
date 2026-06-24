"""
네이버 카페글 수집기 — 웹 어드민
실행: python app.py
접속: http://localhost:5000
"""

import os
import uuid
import threading
from pathlib import Path
from datetime import datetime

from flask import (
    Flask, render_template, request,
    jsonify, send_file, abort
)

from naver_cafe_collector import fetch_html, extract_posts, save_csv

app = Flask(__name__)

OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

# job_id → {status, results, files, error}
JOBS: dict[str, dict] = {}


def _run_job(job_id: str, keywords: list[str], headless: bool):
    job = JOBS[job_id]
    job["status"] = "running"
    all_results = []
    files = []
    try:
        for kw in keywords:
            html = fetch_html(kw, headless=headless)
            posts = extract_posts(html)
            if posts:
                path = save_csv(kw, posts, OUTPUT_DIR)
                files.append(str(path))
            all_results.append({"keyword": kw, "posts": posts})
        job["results"] = all_results
        job["files"] = files
        job["status"] = "done"
    except Exception as e:
        job["error"] = str(e)
        job["status"] = "error"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(force=True)
    raw = data.get("keywords", "")
    keywords = [k.strip() for k in raw.replace("\n", ",").split(",") if k.strip()]
    if not keywords:
        return jsonify({"error": "키워드를 입력하세요."}), 400

    headless = data.get("headless", True)
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "results": [], "files": [], "error": ""}
    t = threading.Thread(target=_run_job, args=(job_id, keywords, headless), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/api/status/<job_id>")
def api_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        abort(404)
    return jsonify(job)


@app.route("/api/download")
def api_download():
    path = request.args.get("path", "")
    p = Path(path).resolve()
    # OUTPUT_DIR 안의 파일만 허용
    if not str(p).startswith(str(OUTPUT_DIR.resolve())):
        abort(403)
    if not p.exists():
        abort(404)
    return send_file(p, as_attachment=True)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
