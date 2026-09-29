// 웹 앱용 순위 체크 API + 매일 자동 실행. 기존 db.json / 카페 모니터링과 독립된 rank.json 에 저장한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CHANNELS, fetchKeyword, findTarget, today } = require("./core");

const MAX_RANK = Number(process.env.RANK_MAX || 20);
const DELAY_MS = Number(process.env.RANK_DELAY_MS || 3000);
const AUTO_HOUR = Number(process.env.RANK_AUTO_HOUR || 9); // KST
const KEEP_DAYS = 120;

function mount(app, dataDir) {
  const file = path.join(dataDir, "rank.json");
  let running = false;

  function load() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) return { items: [], history: {}, meta: {} };
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  }
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // items 를 조회해 오늘자 기록으로 저장. 같은 키워드는 한 번만 조회한다.
  async function runChecks(itemIds) {
    if (running) return { busy: true };
    running = true;
    try {
      const date = today();
      const targets = load().items.filter((i) => !itemIds || itemIds.includes(i.id));
      const byKeyword = new Map();
      for (const it of targets) {
        if (!byKeyword.has(it.keyword)) byKeyword.set(it.keyword, []);
        byKeyword.get(it.keyword).push(it);
      }
      for (const [keyword, items] of byKeyword) {
        const fetched = await fetchKeyword(keyword, { maxRank: MAX_RANK, delayMs: DELAY_MS });
        const db = load(); // 조회 중 항목이 삭제/추가될 수 있어 저장 직전에 다시 읽는다
        for (const it of items) {
          if (!db.items.some((x) => x.id === it.id)) continue;
          const rec = {};
          for (const channel of Object.keys(CHANNELS)) {
            const posts = fetched[channel];
            if (posts === null || posts.length === 0) { rec[channel] = { status: "error" }; continue; }
            const hit = findTarget(posts, it);
            rec[channel] = hit ? { status: "hit", rank: hit.rank, title: hit.title } : { status: "miss" };
          }
          (db.history[it.id] ??= {})[date] = rec;
          const dates = Object.keys(db.history[it.id]).sort();
          for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete db.history[it.id][d];
        }
        save(db);
      }
      return { date, count: targets.length };
    } finally {
      running = false;
    }
  }

  app.get("/api/rank", (req, res) => {
    const db = load();
    const items = db.items.filter((i) => !req.query.projectId || i.projectId === req.query.projectId);
    res.json({
      maxRank: MAX_RANK,
      running,
      items: items.map((i) => ({ ...i, history: db.history[i.id] || {} })),
    });
  });

  app.post("/api/rank/items", (req, res) => {
    const b = req.body || {};
    const keyword = String(b.keyword || "").trim();
    const match = String(b.match || "").trim();
    const titleContains = String(b.titleContains || "").trim();
    if (!b.projectId || !keyword || (!match && !titleContains)) return res.status(400).json({ error: "invalid_input" });
    const db = load();
    const item = {
      id: crypto.randomUUID(), projectId: String(b.projectId), keyword,
      label: String(b.label || "").trim() || titleContains || match,
      match, titleContains, createdAt: new Date().toISOString(),
    };
    db.items.push(item);
    save(db);
    res.json(item);
  });

  app.delete("/api/rank/items/:id", (req, res) => {
    const db = load();
    db.items = db.items.filter((i) => i.id !== req.params.id);
    delete db.history[req.params.id];
    save(db);
    res.json({ ok: true });
  });

  // 지금 확인: 응답은 바로 돌려주고 백그라운드에서 조회 (수 분 걸릴 수 있음)
  app.post("/api/rank/run", (req, res) => {
    if (running) return res.status(409).json({ error: "busy" });
    const { projectId, itemId } = req.body || {};
    const ids = load().items.filter((i) => (itemId ? i.id === itemId : !projectId || i.projectId === projectId)).map((i) => i.id);
    if (ids.length === 0) return res.status(400).json({ error: "no_items" });
    runChecks(ids).catch((e) => console.error("[rank] run failed:", e));
    res.json({ started: ids.length });
  });

  // 매일 KST AUTO_HOUR 시 이후 첫 확인 시점에 전체 항목 1회 실행 (RANK_AUTO=off 로 끔)
  if (process.env.RANK_AUTO !== "off") {
    setInterval(() => {
      const kst = new Date(Date.now() + 9 * 3600e3);
      if (running || kst.getUTCHours() < AUTO_HOUR) return;
      const db = load();
      if (db.meta.lastAutoDate === today() || db.items.length === 0) return;
      db.meta.lastAutoDate = today();
      save(db);
      runChecks(null).catch((e) => console.error("[rank] auto run failed:", e));
    }, 10 * 60 * 1000).unref();
  }
}

module.exports = { mount };
