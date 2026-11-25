// 경영관리(입출금 관리): 수입/지출 내역을 기록하고 월별 합계·잔액을 본다.
// 마스터 계정(auth.requireMaster)만 접근할 수 있다. 일반 관리자(admin)는 페이지·API 모두 차단.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
const intOf = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };
const clean = (s, n = 200) => String(s == null ? "" : s).trim().slice(0, n);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function summarize(entries) {
  let income = 0, expense = 0;
  for (const e of entries) { if (e.type === "in") income += e.amount || 0; else expense += e.amount || 0; }
  return { income, expense, net: income - expense };
}

function mount(app, { dataDir, auth } = {}) {
  const requireMaster = auth ? auth.requireMaster : (req, res, next) => next();
  const file = path.join(dataDir || ".", "finance.json");
  const load = () => { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 새로 시작 */ } return { entries: [] }; };
  const save = (db) => fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
  const sorted = (list) => list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));

  // 페이지: 마스터가 아니면 홈으로 (정적 파일 서빙보다 먼저 등록됨)
  app.get(["/finance.html", "/finance"], (req, res, next) => (auth && !auth.isMaster(req) ? res.redirect("/home.html") : next()));

  app.get("/api/finance", requireMaster, (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : null;
    const all = load().entries;
    const list = sorted(month ? all.filter((e) => e.date.startsWith(month)) : all);
    res.json({ entries: list, summary: summarize(list), total: summarize(all) });
  });

  app.get("/api/finance/csv", requireMaster, (req, res) => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["날짜", "구분", "금액", "분류", "거래처", "메모"].map(q).join(",")];
    for (const e of sorted(load().entries).reverse()) rows.push([e.date, e.type === "in" ? "입금" : "출금", e.amount, e.category, e.counterparty, e.note].map(q).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="finance.csv"');
    res.send("﻿" + rows.join("\r\n"));
  });

  function readBody(b, base = {}) {
    const out = { ...base };
    if (b.type !== undefined) { if (b.type !== "in" && b.type !== "out") return { error: "구분은 입금/출금 중 하나여야 합니다." }; out.type = b.type; }
    if (b.amount !== undefined) { const n = intOf(b.amount); if (n == null || n <= 0) return { error: "금액을 0보다 큰 숫자로 입력하세요." }; out.amount = n; }
    if (b.date !== undefined) { if (!DATE_RE.test(String(b.date))) return { error: "날짜 형식이 올바르지 않습니다." }; out.date = b.date; }
    if (b.category !== undefined) out.category = clean(b.category, 40);
    if (b.counterparty !== undefined) out.counterparty = clean(b.counterparty, 80);
    if (b.note !== undefined) out.note = clean(b.note, 300);
    return { value: out };
  }

  app.post("/api/finance", requireMaster, (req, res) => {
    const b = req.body || {};
    if (b.type === undefined || b.amount === undefined) return res.status(400).json({ error: "invalid_input", message: "구분과 금액을 입력하세요." });
    const r = readBody({ date: today(), ...b }, { id: crypto.randomUUID(), category: "", counterparty: "", note: "", createdAt: new Date().toISOString() });
    if (r.error) return res.status(400).json({ error: "invalid_input", message: r.error });
    const db = load();
    db.entries.push(r.value);
    save(db);
    res.status(201).json({ entry: r.value });
  });

  app.patch("/api/finance/:id", requireMaster, (req, res) => {
    const db = load();
    const i = db.entries.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "not_found" });
    const r = readBody(req.body || {}, db.entries[i]);
    if (r.error) return res.status(400).json({ error: "invalid_input", message: r.error });
    db.entries[i] = r.value;
    save(db);
    res.json({ entry: r.value });
  });

  app.delete("/api/finance/:id", requireMaster, (req, res) => {
    const db = load();
    const before = db.entries.length;
    db.entries = db.entries.filter((x) => x.id !== req.params.id);
    save(db);
    res.json({ ok: true, removed: before - db.entries.length });
  });

  return { load };
}

module.exports = { mount, summarize };
