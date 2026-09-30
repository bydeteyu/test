// 웹 앱용 순위 체크 API + 매일 자동 실행. 기존 db.json / 카페 모니터링과 독립된 rank.json 에 저장한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CHANNELS, fetchKeyword, findTarget, today, fetchHtml, extractPosts } = require("./core");

const MAX_RANK = Number(process.env.RANK_MAX || 50);
const DELAY_MS = Number(process.env.RANK_DELAY_MS || 3000);
const AUTO_HOUR = Number(process.env.RANK_AUTO_HOUR || 9); // KST
const SNAP_MAX = Number(process.env.RANK_SNAPSHOT_MAX || 50); // 키워드 검색 시 저장할 상위 개수
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

  // 키워드 목록(+등록 항목)을 조회해 오늘자로 기록한다. 같은 키워드는 한 번만 조회한다.
  //  - 키워드마다 통합/카페 상위 SNAP_MAX개 스냅샷 저장 (키워드만 검색해도 기록됨)
  //  - 그 키워드에 등록된 항목은 MAX_RANK 안에서 순위 판정
  async function runChecks({ keywords = [], itemIds = null, projectId = null } = {}) {
    if (running) return { busy: true };
    running = true;
    try {
      const date = today();
      const items = load().items.filter((i) => itemIds && itemIds.includes(i.id));
      const kws = [...new Set([...keywords, ...items.map((i) => i.keyword)])];
      for (const keyword of kws) {
        const fetched = await fetchKeyword(keyword, { maxRank: SNAP_MAX, delayMs: DELAY_MS });
        const db = load(); // 조회 중 항목이 삭제/추가될 수 있어 저장 직전에 다시 읽는다
        const snap = {};
        for (const channel of Object.keys(CHANNELS)) {
          const posts = fetched[channel];
          snap[channel] = posts === null || posts.length === 0 ? null
            : posts.map((p) => ({ rank: p.rank, type: p.type, title: p.title, link: "https://" + p.key }));
        }
        ((db.snapshots ??= {})[keyword] ??= {})[date] = snap;
        // 이 키워드를 어느 프로젝트가 쓰는지 기록 (프로젝트별 검색 기록 분리용)
        const owners = ((db.kwProjects ??= {})[keyword] ??= []);
        const addOwner = (id) => { if (id && !owners.includes(id)) owners.push(id); };
        if (projectId && keywords.includes(keyword)) addOwner(projectId);
        db.items.filter((x) => x.keyword === keyword && (!itemIds || itemIds.includes(x.id))).forEach((x) => addOwner(x.projectId));
        prune(db.snapshots[keyword]);
        for (const it of db.items.filter((x) => x.keyword === keyword && (!itemIds || itemIds.includes(x.id)))) {
          const rec = {};
          for (const channel of Object.keys(CHANNELS)) {
            const posts = fetched[channel];
            if (posts === null || posts.length === 0) { rec[channel] = { status: "error" }; continue; }
            const hit = findTarget(posts.slice(0, MAX_RANK), it, channel === "integrated" ? { pageText: posts.pageText, anchors: posts.anchors } : {});
            rec[channel] = hit ? { status: "hit", rank: hit.rank ?? null, title: hit.title } : { status: "miss" };
          }
          prune((db.history[it.id] ??= {}))[date] = rec;
        }
        save(db);
      }
      return { date, count: kws.length };
    } finally {
      running = false;
    }
  }
  function prune(byDate) {
    const dates = Object.keys(byDate).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete byDate[d];
    return byDate;
  }

  // 진단용: 서버가 네이버에서 실제로 받은 내용을 보여준다. 예) /api/rank/debug?keyword=대추밭백한의원&q=예약 실패
  app.get("/api/rank/debug", async (req, res) => {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) return res.status(400).json({ error: "keyword_required" });
    const q = String(req.query.q || "").replace(/\s+/g, "");
    const out = {};
    for (const [channel, ch] of Object.entries(CHANNELS)) {
      try {
        const html = await fetchHtml(ch.url(keyword, 1)); // 진단용은 재시도 없이 첫 주소만 (실제 조회는 대체 주소·재시도 사용)
        const posts = extractPosts(html, { onlyTypes: ch.onlyTypes });
        out[channel] = {
          htmlLength: html.length,
          postCount: posts.length,
          posts: posts.slice(0, 15).map((p) => ({ rank: p.rank, type: p.type, key: p.key, title: p.title.slice(0, 60) })),
          cafeLinks: [...html.matchAll(/https?:\/\/(?:m\.)?cafe\.naver\.com\/[^"'\s<>]+/g)].map((m) => m[0]).slice(0, 10),
          textContainsQ: q ? posts.pageText.replace(/\s+/g, "").includes(q) : null,
          textSample: posts.pageText.slice(0, 200),
          titleAnchors: posts.anchors.slice(0, 20).map((a, i) => ({ n: i + 1, text: a.text.slice(0, 50), href: a.href.slice(0, 80) })),
        };
      } catch (e) {
        out[channel] = { error: e.message };
      }
    }
    res.json(out);
  });

  app.get("/api/rank", (req, res) => {
    const db = load();
    const items = db.items.filter((i) => !req.query.projectId || i.projectId === req.query.projectId);
    res.json({
      maxRank: MAX_RANK,
      snapMax: SNAP_MAX,
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
    runChecks({ itemIds: ids }).catch((e) => console.error("[rank] run failed:", e));
    res.json({ started: ids.length });
  });

  // 키워드 검색: 줄바꿈/쉼표로 구분한 키워드를 조회하고 순위 스냅샷을 기록
  app.post("/api/rank/search", (req, res) => {
    if (running) return res.status(409).json({ error: "busy" });
    const keywords = [...new Set(String((req.body || {}).keywords || "").split(/[\n,]/).map((k) => k.trim()).filter(Boolean))].slice(0, 20);
    if (keywords.length === 0) return res.status(400).json({ error: "no_keywords" });
    runChecks({ keywords, projectId: (req.body || {}).projectId || null }).catch((e) => console.error("[rank] search failed:", e));
    res.json({ started: keywords.length, keywords });
  });

  // 스냅샷 목록: ?keyword= 없으면 키워드별 기록 날짜 요약, 있으면 해당 키워드 전체 스냅샷
  app.get("/api/rank/snapshots", (req, res) => {
    const snaps = load().snapshots || {};
    if (req.query.keyword) return res.json({ keyword: req.query.keyword, byDate: snaps[req.query.keyword] || {} });
    const owners = load().kwProjects || {};
    const pid = req.query.projectId;
    // 프로젝트가 지정되면 그 프로젝트가 쓰는 키워드만 (프로젝트 기능 도입 전 기록은 소유자 정보가 없어 모든 프로젝트에 보임)
    const mine = Object.entries(snaps).filter(([keyword]) => !pid || !owners[keyword] || owners[keyword].includes(pid));
    res.json({ keywords: mine.map(([keyword, byDate]) => ({ keyword, dates: Object.keys(byDate).sort().reverse() })) });
  });

  // 프로젝트 삭제 시 순위 체크 데이터 정리 (프로젝트 자체는 /api/projects 에서 삭제)
  app.post("/api/rank/purge", (req, res) => {
    const pid = String((req.body || {}).projectId || "");
    if (!pid) return res.status(400).json({ error: "invalid_input" });
    const db = load();
    for (const it of db.items.filter((i) => i.projectId === pid)) delete db.history[it.id];
    db.items = db.items.filter((i) => i.projectId !== pid);
    for (const [kw, owners] of Object.entries(db.kwProjects || {})) {
      db.kwProjects[kw] = owners.filter((o) => o !== pid);
      if (db.kwProjects[kw].length === 0 && !db.items.some((i) => i.keyword === kw)) { delete db.kwProjects[kw]; delete (db.snapshots || {})[kw]; }
    }
    save(db);
    res.json({ ok: true });
  });

  app.get("/rank", (req, res) => res.redirect("/rank.html"));

  // 매일 KST AUTO_HOUR 시 이후 첫 확인 시점에 전체 항목 1회 실행 (RANK_AUTO=off 로 끔)
  if (process.env.RANK_AUTO !== "off") {
    setInterval(() => {
      const kst = new Date(Date.now() + 9 * 3600e3);
      if (running || kst.getUTCHours() < AUTO_HOUR) return;
      const db = load();
      if (db.meta.lastAutoDate === today() || (db.items.length === 0 && !Object.keys(db.snapshots || {}).length)) return;
      db.meta.lastAutoDate = today();
      save(db);
      runChecks({ itemIds: db.items.map((i) => i.id), keywords: Object.keys(db.snapshots || {}) }).catch((e) => console.error("[rank] auto run failed:", e));
    }, 10 * 60 * 1000).unref();
  }
}

module.exports = { mount };
