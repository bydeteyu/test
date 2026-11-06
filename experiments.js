// 실험 노트: 가설·진행·결과를 간단히 표에 기록한다(엑셀 메모 느낌). 로그인한 관리자만 사용하며,
// 다른 데이터와 독립된 experiments.json 에 저장한다. CSV(엑셀에서 열림)로 내려받을 수 있다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const FIELDS = ["date", "author", "category", "hypothesis", "progress", "result", "confidence", "nextStep"];
const HEADERS = ["날짜", "작성자", "분류", "가설", "진행 내용", "결과", "확신도", "다음 할 일"];

function mount(app, { dataDir }) {
  const file = path.join(dataDir, "experiments.json");
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));

  function load() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) return { items: [] };
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf-8"));
      return d && Array.isArray(d.items) ? d : { items: [] };
    } catch { return { items: [] }; }
  }
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const clean = (v) => String(v ?? "").slice(0, 4000);
  // 최신(날짜 내림차순, 같은 날짜면 작성 순 내림차순)
  const sortDesc = (a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "");

  app.get("/api/experiments", requireAdmin, (req, res) => {
    res.json({ items: load().items.slice().sort(sortDesc) });
  });

  app.post("/api/experiments", requireAdmin, (req, res) => {
    const b = req.body || {};
    const item = { id: crypto.randomBytes(6).toString("hex"), createdAt: new Date().toISOString() };
    for (const f of FIELDS) item[f] = clean(b[f]);
    if (!item.date) item.date = KST();
    if (!item.author && req.user && req.user.name) item.author = clean(req.user.name);
    item.comments = [];
    const db = load();
    db.items.push(item);
    save(db);
    res.json({ item });
  });

  // ---- 동료 코멘트 ----
  app.post("/api/experiments/:id/comments", requireAdmin, (req, res) => {
    const db = load();
    const it = db.items.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const text = clean(b.text);
    if (!text) return res.status(400).json({ error: "empty", message: "코멘트 내용을 입력하세요." });
    const author = clean(b.author) || (req.user && req.user.name) || "";
    const c = { id: crypto.randomBytes(6).toString("hex"), author, text, createdAt: new Date().toISOString() };
    (it.comments ??= []).push(c);
    save(db);
    res.json({ comment: c, comments: it.comments });
  });

  app.delete("/api/experiments/:id/comments/:cid", requireAdmin, (req, res) => {
    const db = load();
    const it = db.items.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: "not_found" });
    const before = (it.comments || []).length;
    it.comments = (it.comments || []).filter((c) => c.id !== req.params.cid);
    save(db);
    res.json({ ok: true, removed: before - it.comments.length, comments: it.comments });
  });

  app.patch("/api/experiments/:id", requireAdmin, (req, res) => {
    const db = load();
    const it = db.items.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    for (const f of FIELDS) if (f in b) it[f] = clean(b[f]);
    save(db);
    res.json({ item: it });
  });

  app.delete("/api/experiments/:id", requireAdmin, (req, res) => {
    const db = load();
    const before = db.items.length;
    db.items = db.items.filter((x) => x.id !== req.params.id);
    save(db);
    res.json({ ok: true, removed: before - db.items.length });
  });

  // 백업: 전체 기록을 JSON 파일로 내려받는다(복원용 — CSV와 달리 그대로 되돌릴 수 있음).
  app.get("/api/experiments/backup.json", requireAdmin, (req, res) => {
    const db = load();
    const name = `실험노트_백업_${KST()}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="experiments_backup_${KST()}.json"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: db.items.length, items: db.items }, null, 2));
  });

  // 복원: 백업 JSON({items:[...]} 또는 배열)을 가져온다.
  //  mode=merge(기본): 기존에 없는 id만 추가(비파괴적) · mode=replace: 전체 교체
  const normItem = (it) => {
    const o = { id: (typeof it.id === "string" && it.id) || crypto.randomBytes(6).toString("hex"), createdAt: it.createdAt || new Date().toISOString() };
    for (const f of FIELDS) o[f] = clean(it[f]);
    if (!o.date) o.date = KST();
    o.comments = Array.isArray(it.comments)
      ? it.comments.filter((c) => c && c.text).map((c) => ({ id: (typeof c.id === "string" && c.id) || crypto.randomBytes(6).toString("hex"), author: clean(c.author), text: clean(c.text), createdAt: c.createdAt || new Date().toISOString() }))
      : [];
    return o;
  };
  app.post("/api/experiments/import", requireAdmin, (req, res) => {
    const b = req.body || {};
    const incoming = Array.isArray(b) ? b : Array.isArray(b.items) ? b.items : null;
    if (!incoming) return res.status(400).json({ error: "invalid", message: "items 배열이 필요합니다(백업 파일 형식 확인)." });
    const mode = b.mode === "replace" ? "replace" : "merge";
    const db = load();
    let added = 0;
    if (mode === "replace") {
      db.items = incoming.map(normItem);
      added = db.items.length;
    } else {
      const ids = new Set(db.items.map((x) => x.id));
      for (const it of incoming) {
        const o = normItem(it);
        if (!ids.has(o.id)) { db.items.push(o); ids.add(o.id); added++; }
      }
    }
    save(db);
    res.json({ ok: true, mode, added, total: db.items.length });
  });

  // 저장 위치/영구성 상태 (화면 안내용)
  app.get("/api/experiments/storage", requireAdmin, (req, res) => {
    const volatileStorage = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) && !process.env.RAILWAY_VOLUME_MOUNT_PATH;
    res.json({ persistent: !volatileStorage, file: file });
  });

  // 엑셀에서 바로 열리는 CSV(UTF-8 BOM). 오래된 것부터(위에서 아래로) 기록 순.
  app.get("/api/experiments/export.csv", requireAdmin, (req, res) => {
    const items = load().items.slice().sort((a, b) => sortDesc(b, a));
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [HEADERS.map(q).join(",")];
    for (const it of items) lines.push(FIELDS.map((f) => q(it[f])).join(","));
    const csv = "﻿" + lines.join("\r\n");
    const name = `실험노트_${KST()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="experiments_${KST()}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(csv);
  });

  return { FIELDS, HEADERS };
}

module.exports = { mount, FIELDS, HEADERS };
