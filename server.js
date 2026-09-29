const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

function seedData() {
  const now = new Date().toISOString();
  return {
    projects: [
      {
        id: "bundang-miso",
        name: "분당미소한의원",
        industry: "의료/헬스케어",
        goal: "",
        targetAudience: "",
        priorityChannels: "블로그·SEO, 온라인 커뮤니티(지역 맘카페)",
        bannedWords: "완치, 100% 효과 등 과장광고 표현 (의료법 광고 규정 확인 필요)",
        owner: "",
        researcher: "",
        dueDate: "",
        createdAt: now
      }
    ],
    keywords: [
      { id: "bm-01", projectId: "bundang-miso", keyword: "분당 한의원", channel: "블로그·SEO", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "지역 대표 키워드 후보 — 검색량/경쟁강도 데이터랩·블랙키위로 검증 필요", createdAt: now },
      { id: "bm-02", projectId: "bundang-miso", keyword: "분당 체질개선 한방다이어트", channel: "블로그·SEO", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "지역명+진료과목 조합 후보 — 실제 주력 시술 확인 후 채택 검토", createdAt: now },
      { id: "bm-03", projectId: "bundang-miso", keyword: "분당 다이어트한약", channel: "블로그·SEO", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "진료과목 후보 키워드 — 검증 필요", createdAt: now },
      { id: "bm-04", projectId: "bundang-miso", keyword: "분당 추나요법", channel: "블로그·SEO", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "진료과목 후보 키워드 — 검증 필요", createdAt: now },
      { id: "bm-05", projectId: "bundang-miso", keyword: "분당 교통사고한의원", channel: "블로그·SEO", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "진료과목 후보 키워드 — 검증 필요", createdAt: now },
      { id: "bm-06", projectId: "bundang-miso", keyword: "다이어트한약 부작용", channel: "온라인 커뮤니티", volumeScore: 0, competitionScore: 0, trendScore: 0, brandFitScore: 0, viralScore: 0, owner: "", notes: "롱테일·정보성 키워드 후보(전환에 유리) — 검증 필요", createdAt: now }
    ]
  };
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedData(), null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  if (!db.matches) db.matches = [];
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function clampScore(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const SCORE_FIELDS = ["volumeScore", "competitionScore", "trendScore", "brandFitScore", "viralScore"];

// ---- projects ----
app.get("/api/projects", (req, res) => {
  res.json(loadDb().projects);
});

app.post("/api/projects", (req, res) => {
  const db = loadDb();
  const project = Object.assign(
    { id: crypto.randomUUID(), createdAt: new Date().toISOString() },
    req.body
  );
  db.projects.push(project);
  saveDb(db);
  res.status(201).json(project);
});

app.patch("/api/projects/:id", (req, res) => {
  const db = loadDb();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "not_found" });
  Object.assign(project, req.body);
  saveDb(db);
  res.json(project);
});

app.delete("/api/projects/:id", (req, res) => {
  const db = loadDb();
  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  db.keywords = db.keywords.filter((k) => k.projectId !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---- keywords ----
app.get("/api/keywords", (req, res) => {
  const db = loadDb();
  const { projectId } = req.query;
  res.json(projectId ? db.keywords.filter((k) => k.projectId === projectId) : db.keywords);
});

app.post("/api/keywords", (req, res) => {
  const db = loadDb();
  const body = Object.assign({}, req.body);
  SCORE_FIELDS.forEach((f) => { body[f] = clampScore(body[f]); });
  if (!body.keyword || !String(body.keyword).trim()) {
    return res.status(400).json({ error: "keyword_required" });
  }
  const keyword = Object.assign(
    { id: crypto.randomUUID(), createdAt: new Date().toISOString() },
    body
  );
  db.keywords.push(keyword);
  saveDb(db);
  res.status(201).json(keyword);
});

app.patch("/api/keywords/:id", (req, res) => {
  const db = loadDb();
  const keyword = db.keywords.find((k) => k.id === req.params.id);
  if (!keyword) return res.status(404).json({ error: "not_found" });
  const body = Object.assign({}, req.body);
  SCORE_FIELDS.forEach((f) => { if (f in body) body[f] = clampScore(body[f]); });
  Object.assign(keyword, body);
  saveDb(db);
  res.json(keyword);
});

app.delete("/api/keywords/:id", (req, res) => {
  const db = loadDb();
  db.keywords = db.keywords.filter((k) => k.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---- cafe monitor (Naver Search Open API — title/description matches only) ----
function stripTags(s) {
  return String(s || "")
    .replace(/<\/?b>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

async function searchCafeArticles(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error("missing_api_key");
    err.code = "missing_api_key";
    throw err;
  }
  const url = "https://openapi.naver.com/v1/search/cafearticle.json?display=100&sort=date&query=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret
    }
  });
  if (!res.ok) {
    const err = new Error("naver_api_error_" + res.status);
    err.code = "naver_api_error";
    throw err;
  }
  const body = await res.json();
  return (body.items || []).map((item) => ({
    title: stripTags(item.title),
    link: item.link,
    description: stripTags(item.description),
    cafename: stripTags(item.cafename)
  }));
}

app.post("/api/monitor/run", async (req, res) => {
  const db = loadDb();
  const { projectId } = req.body || {};
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "not_found" });

  const cafeName = String(project.cafeName || "").trim();
  const keywords = String(project.watchKeywords || "")
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (!cafeName || keywords.length === 0) {
    return res.status(400).json({ error: "watch_not_configured" });
  }

  const existingLinks = new Set(db.matches.filter((m) => m.projectId === projectId).map((m) => m.link));
  const added = [];

  try {
    for (const keyword of keywords) {
      const items = await searchCafeArticles(keyword);
      for (const item of items) {
        if (!item.cafename || !item.cafename.includes(cafeName)) continue;
        if (existingLinks.has(item.link)) continue;
        existingLinks.add(item.link);
        const match = {
          id: crypto.randomUUID(),
          projectId,
          keyword,
          title: item.title,
          description: item.description,
          link: item.link,
          cafename: item.cafename,
          reviewed: false,
          foundAt: new Date().toISOString()
        };
        db.matches.push(match);
        added.push(match);
      }
    }
  } catch (err) {
    if (err.code === "missing_api_key") {
      return res.status(500).json({ error: "missing_api_key", message: "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경 변수가 설정되어 있지 않습니다." });
    }
    return res.status(502).json({ error: err.code || "search_failed" });
  }

  saveDb(db);
  res.json({ newCount: added.length, matches: added });
});

app.get("/api/matches", (req, res) => {
  const db = loadDb();
  const { projectId } = req.query;
  const matches = projectId ? db.matches.filter((m) => m.projectId === projectId) : db.matches;
  matches.sort((a, b) => (b.foundAt || "").localeCompare(a.foundAt || ""));
  res.json(matches);
});

app.patch("/api/matches/:id", (req, res) => {
  const db = loadDb();
  const match = db.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "not_found" });
  Object.assign(match, req.body);
  saveDb(db);
  res.json(match);
});

app.delete("/api/matches/:id", (req, res) => {
  const db = loadDb();
  db.matches = db.matches.filter((m) => m.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`keyword-research-board listening on port ${PORT}`);
});
