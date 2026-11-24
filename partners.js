// 업체(파트너) 관리: 선금(예치금)을 충전해 두고, 작업(스레드 발행·댓글 추가 등)마다 금액을 차감한다.
// 잔액 = 충전 합계 - 차감 합계. 파트너마다 요율표(비용 조건+단가)는 자유롭게 수정 가능하다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
const intOf = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };
const clean = (s, n = 200) => String(s == null ? "" : s).trim().slice(0, n);

function balanceOf(p) {
  let bal = 0;
  for (const e of p.entries || []) bal += e.type === "topup" ? (e.amount || 0) : -(e.amount || 0);
  return bal;
}

function mount(app, { dataDir } = {}) {
  const requireAdmin = (req, res, next) => (req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }));
  const file = path.join(dataDir || ".", "partners.json");
  function load() {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* 새로 시작 */ }
    return { partners: [] };
  }
  function save(db) { fs.writeFileSync(file, JSON.stringify(db, null, 2)); }

  const cleanRates = (rates) => (Array.isArray(rates) ? rates : []).map((r) => ({ id: (r && r.id) || crypto.randomUUID(), label: clean(r && r.label, 60), price: Math.max(0, intOf(r && r.price) || 0) })).filter((r) => r.label).slice(0, 50);
  const pub = (p) => ({ id: p.id, name: p.name, media: p.media || "", memo: p.memo || "", rates: p.rates || [], entries: (p.entries || []).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1))), balance: balanceOf(p), createdAt: p.createdAt || null });

  app.get("/api/partners", requireAdmin, (req, res) => {
    const db = load();
    res.json({ partners: db.partners.map(pub) });
  });

  app.post("/api/partners", requireAdmin, (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: "invalid_input", message: "파트너(업체) 이름을 입력하세요." });
    const db = load();
    const p = { id: crypto.randomUUID(), name, media: clean(b.media, 40), memo: clean(b.memo, 2000), rates: cleanRates(b.rates), entries: [], createdAt: new Date().toISOString() };
    db.partners.push(p);
    save(db);
    res.status(201).json({ partner: pub(p) });
  });

  app.patch("/api/partners/:id", requireAdmin, (req, res) => {
    const db = load();
    const p = db.partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    if (b.name !== undefined) { const n = clean(b.name, 80); if (!n) return res.status(400).json({ error: "invalid_input", message: "이름을 입력하세요." }); p.name = n; }
    if (b.media !== undefined) p.media = clean(b.media, 40);
    if (b.memo !== undefined) p.memo = clean(b.memo, 2000);
    if (b.rates !== undefined) p.rates = cleanRates(b.rates);
    save(db);
    res.json({ partner: pub(p) });
  });

  app.delete("/api/partners/:id", requireAdmin, (req, res) => {
    const db = load();
    const before = db.partners.length;
    db.partners = db.partners.filter((x) => x.id !== req.params.id);
    save(db);
    res.json({ ok: true, removed: before - db.partners.length });
  });

  // 내역 추가: type=topup(충전) 또는 charge(차감)
  app.post("/api/partners/:id/entries", requireAdmin, (req, res) => {
    const db = load();
    const p = db.partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const type = b.type === "topup" ? "topup" : "charge";
    const amount = intOf(b.amount);
    if (amount == null || amount <= 0) return res.status(400).json({ error: "invalid_input", message: "금액을 0보다 큰 숫자로 입력하세요." });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : today();
    const label = clean(b.label, 80) || (type === "topup" ? "선금 충전" : "차감");
    const e = { id: crypto.randomUUID(), type, date, label, amount, note: clean(b.note, 300), createdAt: new Date().toISOString() };
    (p.entries ??= []).push(e);
    save(db);
    res.status(201).json({ entry: e, balance: balanceOf(p) });
  });

  app.delete("/api/partners/:id/entries/:eid", requireAdmin, (req, res) => {
    const db = load();
    const p = db.partners.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const before = (p.entries || []).length;
    p.entries = (p.entries || []).filter((e) => e.id !== req.params.eid);
    save(db);
    res.json({ ok: true, removed: before - p.entries.length, balance: balanceOf(p) });
  });

  return { load, balanceOf };
}

module.exports = { mount, balanceOf };
