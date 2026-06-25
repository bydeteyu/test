"""
네이버 카페글 수집기 + 조회수 추적기 — 웹 어드민
실행: python app.py
접속: http://localhost:5000
"""

import os
import csv
import uuid
import threading
from io import StringIO
from pathlib import Path
from datetime import datetime

from flask import Flask, render_template, request, jsonify, send_file, abort, make_response

from naver_cafe_collector import fetch_html, extract_posts, save_csv
from naver_cafe_tracker import run_tracker

app = Flask(__name__)

OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

JOBS: dict[str, dict] = {}


# ── 수집기 ──────────────────────────────────────
def _run_collect_job(job_id, keywords):
    job = JOBS[job_id]
    job["status"] = "running"
    all_results, files = [], []
    try:
        for kw in keywords:
            html = fetch_html(kw, headless=True)
            posts = extract_posts(html)
            if posts:
                path = save_csv(kw, posts, OUTPUT_DIR)
                files.append(str(path))
            all_results.append({"keyword": kw, "posts": posts})
        job.update({"results": all_results, "files": files, "status": "done"})
    except Exception as e:
        job.update({"error": str(e), "status": "error"})


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
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "results": [], "files": [], "error": ""}
    threading.Thread(target=_run_collect_job, args=(job_id, keywords), daemon=True).start()
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
    if not str(p).startswith(str(OUTPUT_DIR.resolve())):
        abort(403)
    if not p.exists():
        abort(404)
    return send_file(p, as_attachment=True)


# ── 추적기 ──────────────────────────────────────
def _run_track_job(job_id, urls, cookie):
    job = JOBS[job_id]
    job["status"] = "running"
    try:
        rows = run_tracker(urls, cookie)
        job.update({"rows": rows, "status": "done"})
    except Exception as e:
        job.update({"error": str(e), "status": "error"})


@app.route("/api/track", methods=["POST"])
def api_track():
    data = request.get_json(force=True)
    raw = data.get("urls", "")
    urls = [u.strip() for u in raw.splitlines() if u.strip()]
    if not urls:
        return jsonify({"error": "URL을 입력하세요."}), 400
    cookie = data.get("cookie", "")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "rows": [], "error": ""}
    threading.Thread(target=_run_track_job, args=(job_id, urls, cookie), daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/track/download")
def api_track_download():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job or job["status"] != "done":
        abort(404)
    rows = job["rows"]
    si = StringIO()
    fields = ["date", "title", "read_count", "comment_count", "url", "error"]
    w = csv.DictWriter(si, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    output = make_response(si.getvalue().encode("utf-8-sig"))
    output.headers["Content-Disposition"] = "attachment; filename=tracker_result.csv"
    output.headers["Content-Type"] = "text/csv; charset=utf-8"
    return output


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
