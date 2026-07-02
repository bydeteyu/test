"""
네이버 카페 어드민 — 페이지 분리 버전
/ → 메인
/collect → 카페글 수집
/track → 조회수 추적
/rank → 검색 순위 + 매치도
/suggest → 자동완성 키워드 수집
"""

import os
import csv
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import StringIO
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file, abort, make_response

from naver_cafe_collector import fetch_html, extract_posts, save_csv, save_excel_combined
from naver_cafe_tracker import run_tracker
from naver_rank_search import run_rank_search
from naver_keywordtool import run_keywordtool, credentials_ready

app = Flask(__name__)
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)
JOBS: dict[str, dict] = {}
COLLECT_WORKERS = 2  # 동시 처리 키워드 수 (스레드 한계 고려)


# ── 페이지 ──
@app.route("/")
def index(): return render_template("index.html")

@app.route("/collect")
def page_collect(): return render_template("collect.html")

@app.route("/track")
def page_track(): return render_template("track.html")

@app.route("/rank")
def page_rank(): return render_template("rank.html")

@app.route("/suggest")
def page_suggest(): return render_template("suggest.html")


# ── 카페글 수집 ──
def _collect_one(kw):
    """키워드 1개 수집 — 스레드풀에서 병렬 호출됨."""
    html = fetch_html(kw, headless=True)
    posts = extract_posts(html)
    return kw, posts

def _run_collect(job_id, keywords):
    job = JOBS[job_id]
    job.update({"status": "running", "total": len(keywords), "done_count": 0})
    all_results = []
    lock = threading.Lock()

    def _worker(kw):
        try:
            kw, posts = _collect_one(kw)
        except Exception as e:
            kw, posts = kw, []
            with lock:
                job.setdefault("errors", []).append(f"{kw}: {e}")
        with lock:
            all_results.append({"keyword": kw, "posts": posts})
            job["done_count"] += 1

    try:
        with ThreadPoolExecutor(max_workers=COLLECT_WORKERS) as pool:
            list(pool.map(_worker, keywords))
        order = {kw: i for i, kw in enumerate(keywords)}
        all_results.sort(key=lambda r: order.get(r["keyword"], 0))
        # 전체 키워드를 하나의 엑셀로 저장
        excel_path = str(save_excel_combined(all_results, OUTPUT_DIR))
        job.update({"results": all_results, "excel": excel_path, "status": "done"})
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
    resp = dict(job)
    # 진행률 계산
    total = resp.get("total", 0)
    done = resp.get("done_count", 0)
    resp["progress"] = round(done / total * 100) if total else 0
    return jsonify(resp)

@app.route("/api/download")
def api_download():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job or job.get("status") != "done": abort(404)
    excel = job.get("excel", "")
    p = Path(excel).resolve()
    if not str(p).startswith(str(OUTPUT_DIR.resolve())): abort(403)
    if not p.exists(): abort(404)
    return send_file(p, as_attachment=True, download_name=p.name)


# ── 조회수 추적 ──
def _run_track(job_id, urls, cookie):
    job = JOBS[job_id]
    valid = [u.strip() for u in urls if u.strip() and not u.strip().startswith("#")]
    job.update({"status": "running", "total": len(valid), "done_count": 0})

    def _progress(done, total):
        job["done_count"] = done

    try:
        rows = run_tracker(urls, cookie, progress_cb=_progress)
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
    job = JOBS[job_id]
    job.update({"status": "running", "total": len(keywords), "done_count": 0})
    results = []
    lock = threading.Lock()

    def _rank_worker(kw):
        try:
            res = run_rank_search([kw])[0]
        except Exception as e:
            res = {"keyword": kw, "posts": [{"rank": "-", "title": str(e), "cafe": "", "score": 0, "link": ""}]}
        with lock:
            results.append(res)
            job["done_count"] += 1

    try:
        with ThreadPoolExecutor(max_workers=COLLECT_WORKERS) as pool:
            list(pool.map(_rank_worker, keywords))
        order = {kw: i for i, kw in enumerate(keywords)}
        results.sort(key=lambda r: order.get(r["keyword"], 0))
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


# ── 연관 키워드 + 검색량 조회 (검색광고 API) ──
def _run_suggest(job_id, keywords):
    job = JOBS[job_id]
    job.update({"status": "running", "done_count": 0, "total": len(keywords)})

    def _progress(done, total):
        job.update({"done_count": done, "total": total})

    try:
        rows, errors = run_keywordtool(keywords, progress_cb=_progress)
        job.update({"rows": rows, "errors": errors, "status": "done"})
    except Exception as e:
        job.update({"error": str(e), "status": "error"})

@app.route("/api/suggest", methods=["POST"])
def api_suggest():
    if not credentials_ready():
        return jsonify({"error": "검색광고 API 인증정보(환경변수)가 설정되지 않았습니다."}), 400
    data = request.get_json(force=True)
    raw = data.get("seed", "") or data.get("keywords", "")
    keywords = [k.strip() for k in raw.replace("\n", ",").split(",") if k.strip()]
    if not keywords:
        return jsonify({"error": "키워드를 입력하세요."}), 400
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "rows": [], "error": ""}
    threading.Thread(target=_run_suggest, args=(job_id, keywords), daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route("/api/suggest/download")
def api_suggest_download():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job or job["status"] != "done":
        abort(404)
    si = StringIO()
    w = csv.writer(si)
    w.writerow(["키워드", "PC검색량", "모바일검색량", "총검색량", "경쟁정도"])
    for r in job["rows"]:
        w.writerow([r["keyword"], r["pc"], r["mobile"], r["total"], r["comp"]])
    output = make_response(si.getvalue().encode("utf-8-sig"))
    output.headers["Content-Disposition"] = "attachment; filename=keyword_volume.csv"
    output.headers["Content-Type"] = "text/csv; charset=utf-8"
    return output


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
