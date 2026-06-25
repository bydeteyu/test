"""
네이버 카페 어드민 — 페이지 분리 버전
/ → 메인
/collect → 카페글 수집
/track → 조회수 추적
/rank → 검색 순위 + 매치도
"""

import os
import csv
import uuid
import threading
from io import StringIO
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file, abort, make_response

from naver_cafe_collector import fetch_html, extract_posts, save_csv
from naver_cafe_tracker import run_tracker
from naver_rank_search import run_rank_search

app = Flask(__name__)
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)
JOBS: dict[str, dict] = {}


# ── 페이지 ──
@app.route("/")
def index(): return render_template("index.html")

@app.route("/collect")
def page_collect(): return render_template("collect.html")

@app.route("/track")
def page_track(): return render_template("track.html")

@app.route("/rank")
def page_rank(): return render_template("rank.html")


# ── 카페글 수집 ──
def _run_collect(job_id, keywords):
    job = JOBS[job_id]; job["status"] = "running"
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

@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(force=True)
    raw = data.get("keywords", "")
    keywords = [k.strip() for k in raw.replace("\n", ",").split(",") if k.strip()]
    if not keywords: return jsonify({"error": "키워드를 입력하세요."}), 400
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "results": [], "files": [], "error": ""}
    threading.Thread(target=_run_collect, args=(job_id, keywords), daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route("/api/status/<job_id>")
def api_status(job_id):
    job = JOBS.get(job_id)
    if not job: abort(404)
    return jsonify(job)

@app.route("/api/download")
def api_download():
    path = request.args.get("path", "")
    p = Path(path).resolve()
    if not str(p).startswith(str(OUTPUT_DIR.resolve())): abort(403)
    if not p.exists(): abort(404)
    return send_file(p, as_attachment=True)


# ── 조회수 추적 ──
def _run_track(job_id, urls, cookie):
    job = JOBS[job_id]; job["status"] = "running"
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
    if not urls: return jsonify({"error": "URL을 입력하세요."}), 400
    cookie = data.get("cookie", "")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "rows": [], "error": ""}
    threading.Thread(target=_run_track, args=(job_id, urls, cookie), daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route("/api/track/download")
def api_track_download():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job or job["status"] != "done": abort(404)
    si = StringIO()
    fields = ["date", "title", "read_count", "comment_count", "url", "error"]
    w = csv.DictWriter(si, fieldnames=fields, extrasaction="ignore")
    w.writeheader(); w.writerows(job["rows"])
    output = make_response(si.getvalue().encode("utf-8-sig"))
    output.headers["Content-Disposition"] = "attachment; filename=tracker_result.csv"
    output.headers["Content-Type"] = "text/csv; charset=utf-8"
    return output


# ── 검색 순위 ──
def _run_rank(job_id, keywords):
    job = JOBS[job_id]; job["status"] = "running"
    try:
        results = run_rank_search(keywords)
        job.update({"results": results, "status": "done"})
    except Exception as e:
        job.update({"error": str(e), "status": "error"})

@app.route("/api/rank", methods=["POST"])
def api_rank():
    data = request.get_json(force=True)
    raw = data.get("keywords", "")
    keywords = [k.strip() for k in raw.replace("\n", ",").split(",") if k.strip()]
    if not keywords: return jsonify({"error": "키워드를 입력하세요."}), 400
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "results": [], "error": ""}
    threading.Thread(target=_run_rank, args=(job_id, keywords), daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route("/api/rank/download")
def api_rank_download():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job or job["status"] != "done": abort(404)
    si = StringIO()
    fields = ["keyword", "rank", "score", "title", "cafe", "link"]
    w = csv.DictWriter(si, fieldnames=fields)
    w.writeheader()
    for r in job["results"]:
        for p in r["posts"]:
            w.writerow({"keyword": r["keyword"], **{k: p.get(k, "") for k in ["rank","score","title","cafe","link"]}})
    output = make_response(si.getvalue().encode("utf-8-sig"))
    output.headers["Content-Disposition"] = "attachment; filename=rank_result.csv"
    output.headers["Content-Type"] = "text/csv; charset=utf-8"
    return output


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
