// 웹 앱용 순위 체크 API + 매일 자동 실행. 기존 db.json / 카페 모니터링과 독립된 rank.json 에 저장한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildWorkbook } = require("./xlsx");
const { normalize, fetchCafeViews, locatePost, resolveShortUrl, ensureMatchKey, CHANNELS, SOURCE, apiConfigured, fetchKeyword, findTarget, today, fetchHtml, extractPosts } = require("./core");

const MAX_RANK = Number(process.env.RANK_MAX || 30);
const DELAY_MS = Number(process.env.RANK_DELAY_MS || 3000);
const AUTO_HOUR = Number(process.env.RANK_AUTO_HOUR || 9); // KST
const SNAP_MAX = Number(process.env.RANK_SNAPSHOT_MAX || 30); // 키워드 검색 시 저장할 상위 개수
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
          await ensureMatchKey(it); // naver.me 같은 단축 주소는 카페 글 키로 풀어 둔다
          const rec = {};
          const hits = {};
          for (const channel of Object.keys(CHANNELS)) {
            const posts = fetched[channel];
            if (posts === null || posts.length === 0) { rec[channel] = { status: "error" }; continue; }
            const hit = findTarget(posts.slice(0, MAX_RANK), it, channel === "integrated" ? { pageText: posts.pageText, anchors: posts.anchors } : {});
            hits[channel] = hit;
            rec[channel] = hit ? { status: "hit", rank: hit.rank ?? null, title: hit.title } : { status: "miss" };
          }
          // 조회수는 순위 범위 밖이어도 기록한다: 이번에 잡힌 글 > 이전에 기억해 둔 글 > 등록한 글 주소 순으로 대상 글을 정한다.
          const hitList = Object.values(hits).filter(Boolean);
          const cafeHit = hitList.find((h) => h.key && h.type === "cafe");
          if (cafeHit) { it.postKey = cafeHit.key; if (cafeHit.art) it.postArt = cafeHit.art; } // 다음에 범위 밖이어도 같은 글의 조회수를 볼 수 있게 기억
          let target = cafeHit ? { key: cafeHit.key, art: cafeHit.art } : null;
          if (!target && it.postKey) target = { key: it.postKey, art: it.postArt };
          if (!target && it.matchKey) target = { key: it.matchKey, art: it.matchArt };
          if (!target && it.match) {
            const ref = normalize(/^https?:\/\//.test(it.match) ? it.match : "https://" + it.match);
            if (ref && ref.type === "cafe") target = { key: ref.key, art: ref.art };
          }
          let v = null, note = null;
          if (target) v = await fetchCafeViews(target.key, { art: target.art });
          else if (hitList.length) note = hitList.find((h) => h.key) ? "카페 글이 아님(블로그·지식iN 등)" : "글 주소를 알 수 없음";
          // 조회수를 못 얻었고(글을 모르거나, 토큰 없이 열리지 않음) 이번 조회에서 새 토큰도 없으면: 제목으로 글을 직접 검색해 토큰을 새로 받아 다시 시도
          const gotViews = v && v.views !== null;
          if (!gotViews && !cafeHit && it.titleContains && !hitList.length) {
            const loc = await locatePost(it);
            if (loc) {
              it.postKey = loc.key;
              if (loc.art) it.postArt = loc.art;
              v = await fetchCafeViews(loc.key, { art: loc.art });
              note = null;
            } else if (!(v && v.reason)) {
              note = "제목으로 검색해도 글을 찾지 못해 조회수를 알 수 없음";
            } else {
              v = { views: null, reason: `${v.reason} (제목 검색으로도 글을 찾지 못함)` };
            }
          }
          for (const rc of Object.values(rec)) {
            if (rc.status === "error") continue;
            if (v && v.views !== null) rc.views = v.views;
            else if (v && v.reason) rc.viewsNote = v.reason;
            else if (note && (rc.status === "hit" || !hitList.length)) rc.viewsNote = note;
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
    if (SOURCE === "api") { // 공식 API 방식: 채널별 상위 결과를 그대로 보여준다
      const fetched = await fetchKeyword(keyword, { maxRank: 15, delayMs: 0 });
      for (const [channel, posts] of Object.entries(fetched)) {
        out[channel] = posts === null ? { error: "조회 실패 (서버 로그와 API 키 설정을 확인하세요)" } : { source: "api", postCount: posts.length, posts: posts.map((p) => ({ rank: p.rank, type: p.type, key: p.key, title: p.title.slice(0, 60) })) };
      }
      return res.json(out);
    }
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

  // 진단용: 카페 글 조회수를 가져오는지 확인. 예) /api/rank/views?url=cafe.naver.com/imsanbu/80153775
  app.get("/api/rank/views", async (req, res) => {
    let raw = String(req.query.url || "").trim();
    let resolvedFrom = null;
    if (/(^|\/\/)naver\.me\//.test(raw)) { const f = await resolveShortUrl(raw); if (f) { resolvedFrom = raw; raw = f; } } // 단축 주소는 풀어서 확인
    const ref = normalize(/^https?:\/\//.test(raw) ? raw : "https://" + raw); // 카페 글 키와 검색 유입 토큰(art)을 모든 주소 형태에서 추출
    const key = ref && ref.type === "cafe" ? ref.key : raw.replace(/^https?:\/\//, "").split(/[?#]/)[0];
    const art = req.query.art || (ref && ref.art) || null;
    const out = await fetchCafeViews(key, { debug: true, art });
    res.json(resolvedFrom ? { resolvedFrom, finalUrl: raw.slice(0, 160) + (raw.length > 160 ? "…" : ""), ...out } : out);
  });

  app.get("/api/rank", (req, res) => {
    const db = load();
    const items = db.items.filter((i) => !req.query.projectId || i.projectId === req.query.projectId);
    res.json({
      maxRank: MAX_RANK,
      snapMax: SNAP_MAX,
      source: SOURCE,
      apiConfigured: SOURCE === "api" ? apiConfigured() : true,
      channels: Object.entries(CHANNELS).map(([key, c]) => ({ key, label: c.label })),
      running,
      items: items.map((i) => ({ ...i, history: db.history[i.id] || {} })),
    });
  });

  // 순위표 엑셀 다운로드: 요약 시트 + 항목별 시트(기록 표와 "더보기"와 같은 차트)
  app.get("/api/rank/xlsx", async (req, res) => {
    const pid = req.query.projectId ? String(req.query.projectId) : null;
    const db = load();
    const items = db.items.filter((i) => !pid || i.projectId === pid).map((i) => ({ ...i, history: db.history[i.id] || {} }));
    let projectName = "";
    try { if (fs.existsSync(path.join(dataDir, "db.json"))) projectName = (JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf-8")).projects || []).find((p) => p.id === pid)?.name || ""; } catch { /* 이름 없이 진행 */ }
    try {
      const buf = await buildWorkbook({ projectName, items, channels: Object.entries(CHANNELS).map(([key, c]) => ({ key, label: c.label })), maxRank: MAX_RANK });
      const filename = `순위표_${projectName || "전체"}_${today()}.xlsx`.replace(/[\\/:*?"<>|]/g, "_");
      res.set("Content-Disposition", `attachment; filename="rank.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buf);
    } catch (e) {
      console.error("[rank] xlsx failed:", e);
      res.status(500).json({ error: "xlsx_failed" });
    }
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

  // 백업/복원: 프로젝트(db.json)와 순위 체크 데이터(rank.json)를 한 파일로 내려받고 다시 올린다.
  const dbFile = path.join(dataDir, "db.json");
  app.get("/api/rank/export", (req, res) => {
    const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : null);
    res.set("Content-Disposition", `attachment; filename="backup-${today()}.json"`);
    const au = app.locals.auth;
    res.type("application/json").send(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), db: readJson(dbFile), rank: load(), users: au ? au.exportUsers() : [] }, null, 2));
  });
  app.post("/api/rank/import", (req, res) => {
    const b = req.body || {};
    const rank = b.rank, db = b.db;
    const okRank = rank && Array.isArray(rank.items) && rank.history && typeof rank.history === "object";
    const okDb = !db || (Array.isArray(db.projects) && Array.isArray(db.keywords));
    if (!okRank || !okDb) return res.status(400).json({ error: "invalid_backup" });
    if (running) return res.status(409).json({ error: "busy" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of [file, dbFile]) if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.before-import-${stamp}`); // 덮어쓰기 전 현재 파일 보관
    const au = app.locals.auth;
    if (Array.isArray(b.users) && au && !req.user?.open) { // 계정 정보도 백업에 있으면 함께 복원 (관리자 전용 API)
      if (fs.existsSync(au.usersFile)) fs.copyFileSync(au.usersFile, `${au.usersFile}.before-import-${stamp}`);
      au.importUsers(b.users);
    }
    fs.writeFileSync(file, JSON.stringify(rank, null, 2));
    if (db) fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
    res.json({ ok: true, items: rank.items.length, projects: db ? db.projects.length : null });
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
