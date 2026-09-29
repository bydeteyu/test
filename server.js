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
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
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

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`keyword-research-board listening on port ${PORT}`);
});
