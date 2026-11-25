// 경영관리(입출금 관리): 수입/지출 내역을 기록하고 월별 합계·잔액을 본다.
// 마스터 계정(auth.requireMaster)만 접근할 수 있다. 일반 관리자(admin)는 페이지·API 모두 차단.
// 데이터 보호: ① 삭제는 "숨김"일 뿐 실제로 지우지 않고(복구 가능) ② 모든 추가/수정/삭제/복구를 finance-log.jsonl 에 덧붙여 기록하며
// ③ 쓰기 전에 하루 1회 finance-backups/ 에 스냅샷을 남기고 ④ 전체 백업 파일(JSON)을 내려받을 수 있다. 파일은 DATA_DIR(영구 볼륨)에 저장된다.
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
  const logFile = path.join(dataDir || ".", "finance-log.jsonl");
  const snapDir = path.join(dataDir || ".", "finance-backups");
  const load = () => { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 새로 시작 */ } return { entries: [] }; };
  // 하루 첫 쓰기 전에 직전 상태를 스냅샷으로 보관(최근 90개 유지), 저장은 임시 파일 → 교체 방식으로 중간에 끊겨도 깨지지 않게 한다.
  function snapshot() {
    try {
      if (!fs.existsSync(file)) return;
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const dst = path.join(snapDir, `finance-${today()}.json`);
      if (!fs.existsSync(dst)) fs.copyFileSync(file, dst);
      const olds = fs.readdirSync(snapDir).filter((f) => /^finance-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 90))) fs.unlinkSync(path.join(snapDir, f));
    } catch { /* 스냅샷 실패가 저장을 막지는 않는다 */ }
  }
  function save(db) {
    snapshot();
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const record = (req, action, before, after) => {
    const row = { at: new Date().toISOString(), by: (req.user && req.user.username) || "", action, id: (after || before || {}).id, before: before || null, after: after || null };
    try { fs.appendFileSync(logFile, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* 기록 실패는 무시 */ }
  };
  const readLog = () => { try { return fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const sorted = (list) => list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));

  // 페이지: 마스터가 아니면 홈으로 (정적 파일 서빙보다 먼저 등록됨)
  app.get(["/finance.html", "/finance"], (req, res, next) => (auth && !auth.isMaster(req) ? res.redirect("/home.html") : next()));

  app.get("/api/finance", requireMaster, (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : null;
    const all = load().entries.filter((e) => !e.deletedAt); // 삭제(숨김) 처리된 내역은 목록·합계에서 제외
    const list = sorted(month ? all.filter((e) => e.date.startsWith(month)) : all);
    res.json({ entries: list, summary: summarize(list), total: summarize(all) });
  });

  // 삭제(숨김)된 내역 목록 — 여기서 복구할 수 있다
  app.get("/api/finance/deleted", requireMaster, (req, res) => res.json({ entries: sorted(load().entries.filter((e) => e.deletedAt)) }));

  // 변경 기록(최신순). 추가/수정/삭제/복구마다 누가 언제 무엇을 바꿨는지 남는다.
  app.get("/api/finance/log", requireMaster, (req, res) => res.json({ log: readLog().reverse().slice(0, Math.min(500, Number(req.query.limit) || 100)) }));

  // 전체 백업 파일(JSON): 삭제된 내역과 변경 기록까지 모두 포함
  app.get("/api/finance/backup", requireMaster, (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="finance-backup-${today()}.json"`);
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), entries: load().entries, log: readLog() }, null, 2));
  });

  app.get("/api/finance/csv", requireMaster, (req, res) => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["날짜", "구분", "금액", "분류", "거래처", "메모"].map(q).join(",")];
    for (const e of sorted(load().entries.filter((x) => !x.deletedAt)).reverse()) rows.push([e.date, e.type === "in" ? "입금" : "출금", e.amount, e.category, e.counterparty, e.note].map(q).join(","));
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
    record(req, "create", null, r.value);
    res.status(201).json({ entry: r.value });
  });

  app.patch("/api/finance/:id", requireMaster, (req, res) => {
    const db = load();
    const i = db.entries.findIndex((x) => x.id === req.params.id && !x.deletedAt);
    if (i < 0) return res.status(404).json({ error: "not_found" });
    const before = db.entries[i];
    const r = readBody(req.body || {}, before);
    if (r.error) return res.status(400).json({ error: "invalid_input", message: r.error });
    db.entries[i] = r.value;
    save(db);
    record(req, "update", before, r.value);
    res.json({ entry: r.value });
  });

  app.delete("/api/finance/:id", requireMaster, (req, res) => {
    const db = load();
    const e = db.entries.find((x) => x.id === req.params.id && !x.deletedAt);
    if (!e) return res.json({ ok: true, removed: 0 });
    const before = { ...e };
    e.deletedAt = new Date().toISOString(); // 실제로 지우지 않고 숨김 처리 (복구 가능)
    e.deletedBy = (req.user && req.user.username) || "";
    save(db);
    record(req, "delete", before, e);
    res.json({ ok: true, removed: 1 });
  });

  app.post("/api/finance/:id/restore", requireMaster, (req, res) => {
    const db = load();
    const e = db.entries.find((x) => x.id === req.params.id && x.deletedAt);
    if (!e) return res.status(404).json({ error: "not_found" });
    const before = { ...e };
    delete e.deletedAt; delete e.deletedBy;
    save(db);
    record(req, "restore", before, e);
    res.json({ entry: e });
  });

  return { load };
}

module.exports = { mount, summarize };
