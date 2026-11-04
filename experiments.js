// 실험 노트: 가설·진행·결과를 간단히 표에 기록한다(엑셀 메모 느낌). 로그인한 관리자만 사용하며,
// 다른 데이터와 독립된 experiments.json 에 저장한다. CSV(엑셀에서 열림)로 내려받을 수 있다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const FIELDS = ["date", "author", "category", "hypothesis", "progress", "result", "judgment", "confidence", "nextStep"];
const HEADERS = ["날짜", "작성자", "분류", "가설", "진행 내용", "결과", "판단", "확신도", "다음 할 일"];

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
    const db = load();
    db.items.push(item);
    save(db);
    res.json({ item });
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
