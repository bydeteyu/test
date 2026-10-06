const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// 헬스체크 (인증 없이 응답) — 배포 플랫폼용
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// 공개 URL로 배포할 때를 위한 선택적 비밀번호 보호 (HTTP Basic).
// APP_PASSWORD 를 설정하면 모든 페이지/API에 로그인이 필요합니다. APP_USER 기본값: admin
if (process.env.APP_PASSWORD) {
  const expectUser = process.env.APP_USER || "admin";
  const expectPass = process.env.APP_PASSWORD;
  const safeEq = (a, b) => {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };
  app.use((req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
    if (m) {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i >= 0 && safeEq(decoded.slice(0, i), expectUser) & safeEq(decoded.slice(i + 1), expectPass)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="keyword-board", charset="UTF-8"');
    res.status(401).send("로그인이 필요합니다.");
  });
}

app.use(express.json({ limit: "8mb" }));
app.get("/api/storage", (req, res) => res.json({ dataDir: DATA_DIR, persistent: !VOLATILE_STORAGE }));

// 데이터 폴더: DATA_DIR > Railway 볼륨 마운트 경로(RAILWAY_VOLUME_MOUNT_PATH) > ./data
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
// Railway 에서 볼륨 없이 실행 중이면 재배포 때마다 데이터가 초기화된다 — 화면에 경고하기 위한 정보
const VOLATILE_STORAGE = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) && !process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (VOLATILE_STORAGE) console.warn("[storage] 영구 볼륨이 연결되지 않았습니다. 재배포하면 데이터가 초기화됩니다. (Railway: 서비스에 Volume 추가)");
console.log("[storage] data dir:", DATA_DIR);
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
  if (!db.suggestions) db.suggestions = [];
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
          source: "auto",
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

app.post("/api/matches", (req, res) => {
  const db = loadDb();
  const body = req.body || {};
  const projectId = body.projectId;
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "not_found" });

  const title = String(body.title || "").trim();
  if (!title) return res.status(400).json({ error: "title_required" });

  const link = String(body.link || "").trim();
  if (link && db.matches.some((m) => m.projectId === projectId && m.link === link)) {
    return res.status(409).json({ error: "duplicate" });
  }

  const match = {
    id: crypto.randomUUID(),
    projectId,
    keyword: String(body.keyword || "").trim() || "(수동 등록)",
    title,
    description: String(body.description || "").trim(),
    link,
    cafename: String(body.cafename || project.cafeName || "").trim(),
    source: "manual",
    reviewed: false,
    foundAt: new Date().toISOString()
  };
  db.matches.push(match);
  saveDb(db);
  res.status(201).json(match);
});

app.post("/api/matches/from-image", async (req, res) => {
  const db = loadDb();
  const body = req.body || {};
  const projectId = body.projectId;
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "not_found" });

  const imageBase64 = String(body.imageBase64 || "");
  if (!imageBase64) return res.status(400).json({ error: "image_required" });
  if (imageBase64.length > 7_000_000) return res.status(400).json({ error: "image_too_large" });
  const mediaType = SCREENSHOT_TYPES.includes(body.mediaType) ? body.mediaType : "image/png";

  const link = String(body.link || "").trim();
  if (link && db.matches.some((m) => m.projectId === projectId && m.link === link)) {
    return res.status(409).json({ error: "duplicate" });
  }

  let extracted;
  try {
    extracted = await extractFromScreenshot(imageBase64, mediaType);
  } catch (err) {
    if (err.code === "missing_llm_key") {
      return res.status(500).json({ error: "missing_llm_key", message: "ANTHROPIC_API_KEY 환경 변수가 설정되어 있지 않습니다." });
    }
    return res.status(502).json({ error: err.code || "extract_failed" });
  }

  const title = String(body.title || extracted.title || "").trim() || "스크린샷 등록";
  const match = {
    id: crypto.randomUUID(),
    projectId,
    keyword: "(스크린샷 등록)",
    title,
    description: String(extracted.content || "").trim(),
    link,
    cafename: String(project.cafeName || "").trim(),
    source: "screenshot",
    reviewed: false,
    foundAt: new Date().toISOString()
  };
  db.matches.push(match);
  const suggestions = addSuggestions(db, project, extracted.keywords);
  saveDb(db);
  res.status(201).json({ match, suggestions });
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

// ---- AI keyword expansion (Claude API — reads found post titles/descriptions only) ----
function buildAnalysisPrompt(project, posts, existingKeywords) {
  const postList = posts
    .map((p, i) => (i + 1) + ". 제목: " + p.title + "\n   설명: " + (p.description || "(없음)"))
    .join("\n");
  return [
    "너는 마케팅 에이전시의 키워드 리서치 담당자다.",
    '아래는 네이버 카페 "' + (project.cafeName || "") + '"에서 감시 키워드로 검색해 발견한 글 목록이다',
    "(클라이언트: " + project.name + ", 업종: " + (project.industry || "미상") + ").",
    "",
    postList,
    "",
    "이 글들에서 실제로 사람들이 궁금해하거나 검색할 법한 표현을 바탕으로, 추가로 감시하면 좋을 검색 키워드 후보를 최대 8개 제안해줘.",
    "조건:",
    "- 위 글 목록에 실제로 등장하거나 명확히 암시된 표현만 근거로 삼을 것 (없는 내용을 지어내지 말 것)",
    "- 이미 감시 중인 키워드(" + (existingKeywords.join(", ") || "없음") + ")와 중복되지 않게",
    '- 2~6단어의 자연스러운 검색어 형태로 (예: "중학생 키 성장", "성장판 자극 방법")',
    "- 각 키워드마다 근거가 된 글의 표현을 한 줄로 설명",
    '- 의료광고 규제상 과장된 효능 표현("완치", "100% 효과" 등)은 키워드로 제안하지 말 것',
    "",
    "다음 JSON 형식으로만 답해라. 다른 설명은 붙이지 마라.",
    '{"keywords":[{"keyword":"...", "reason":"..."}]}'
  ].join("\n");
}

async function callClaudeJSON(content) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("missing_llm_key");
    err.code = "missing_llm_key";
    throw err;
  }
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content }]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error("llm_api_error_" + res.status);
    err.code = "llm_api_error";
    err.detail = detail;
    throw err;
  }
  const body = await res.json();
  const text = (body.content || []).map((c) => c.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    const err = new Error("parse_error");
    err.code = "parse_error";
    err.detail = text;
    throw err;
  }
}

async function analyzeForKeywords(prompt) {
  const parsed = await callClaudeJSON(prompt);
  return Array.isArray(parsed.keywords) ? parsed.keywords : [];
}

const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function extractFromScreenshot(imageBase64, mediaType) {
  const prompt = [
    "너는 마케팅 에이전시의 키워드 리서치 담당자다. 이 이미지는 네이버 카페 게시글(또는 댓글) 스크린샷이다.",
    "이미지에 실제로 보이는 내용만 근거로 다음 JSON을 추출해라. 보이지 않는 내용을 지어내지 마라.",
    "1. title: 글 제목 (안 보이면 본문 첫 문장으로 대체)",
    "2. content: 본문 내용 요약 (2~4문장)",
    "3. keywords: 이 글의 작성자나 댓글 단 사람들이 실제로 검색해볼 법한 바이럴 마케팅 키워드 후보, 최대 5개.",
    '   각 항목은 {"keyword": "2~6단어 자연스러운 검색어", "reason": "이미지의 어떤 표현에서 이 키워드를 뽑았는지 한 줄 근거"} 형태.',
    '   의료광고 규제상 과장된 효능 표현("완치", "100% 효과" 등)은 keywords에 넣지 마라.',
    "",
    "다음 JSON 형식으로만 답해라. 다른 설명은 붙이지 마라.",
    '{"title": "...", "content": "...", "keywords": [{"keyword": "...", "reason": "..."}]}'
  ].join("\n");
  return callClaudeJSON([
    { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
    { type: "text", text: prompt }
  ]);
}

function addSuggestions(db, project, candidates) {
  const existingKeywords = new Set(
    String(project.watchKeywords || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean)
  );
  db.keywords.filter((k) => k.projectId === project.id).forEach((k) => existingKeywords.add(k.keyword));
  db.suggestions.filter((s) => s.projectId === project.id).forEach((s) => existingKeywords.add(s.keyword));

  const added = [];
  for (const item of candidates || []) {
    const keyword = String((item && item.keyword) || "").trim();
    if (!keyword || existingKeywords.has(keyword)) continue;
    existingKeywords.add(keyword);
    const suggestion = {
      id: crypto.randomUUID(),
      projectId: project.id,
      keyword,
      reason: String((item && item.reason) || "").trim(),
      status: "pending",
      createdAt: new Date().toISOString()
    };
    db.suggestions.push(suggestion);
    added.push(suggestion);
  }
  return added;
}

app.post("/api/keywords/suggest", async (req, res) => {
  const db = loadDb();
  const { projectId } = req.body || {};
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "not_found" });

  const posts = db.matches.filter((m) => m.projectId === projectId).slice(0, 30);
  if (posts.length === 0) return res.status(400).json({ error: "no_posts" });

  const existingKeywords = new Set(
    String(project.watchKeywords || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean)
  );
  db.keywords.filter((k) => k.projectId === projectId).forEach((k) => existingKeywords.add(k.keyword));
  db.suggestions.filter((s) => s.projectId === projectId).forEach((s) => existingKeywords.add(s.keyword));

  const prompt = buildAnalysisPrompt(project, posts, Array.from(existingKeywords));

  let suggested;
  try {
    suggested = await analyzeForKeywords(prompt);
  } catch (err) {
    if (err.code === "missing_llm_key") {
      return res.status(500).json({ error: "missing_llm_key", message: "ANTHROPIC_API_KEY 환경 변수가 설정되어 있지 않습니다." });
    }
    return res.status(502).json({ error: err.code || "analysis_failed" });
  }

  const added = addSuggestions(db, project, suggested);
  saveDb(db);
  res.json({ newCount: added.length, suggestions: added });
});

app.get("/api/suggestions", (req, res) => {
  const db = loadDb();
  const { projectId } = req.query;
  const list = projectId ? db.suggestions.filter((s) => s.projectId === projectId) : db.suggestions;
  list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json(list);
});

app.patch("/api/suggestions/:id", (req, res) => {
  const db = loadDb();
  const suggestion = db.suggestions.find((s) => s.id === req.params.id);
  if (!suggestion) return res.status(404).json({ error: "not_found" });
  const nextStatus = req.body && req.body.status;
  Object.assign(suggestion, req.body);

  if (nextStatus === "approved") {
    const project = db.projects.find((p) => p.id === suggestion.projectId);
    if (project) {
      const kws = new Set(String(project.watchKeywords || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean));
      if (!kws.has(suggestion.keyword)) {
        kws.add(suggestion.keyword);
        project.watchKeywords = Array.from(kws).join(", ");
      }
    }
    const alreadyRow = db.keywords.some((k) => k.projectId === suggestion.projectId && k.keyword === suggestion.keyword);
    if (!alreadyRow) {
      db.keywords.push({
        id: crypto.randomUUID(),
        projectId: suggestion.projectId,
        keyword: suggestion.keyword,
        channel: "온라인 커뮤니티",
        volumeScore: 0,
        competitionScore: 0,
        trendScore: 0,
        brandFitScore: 0,
        viralScore: 0,
        owner: "",
        notes: "AI 리서치 제안 — 근거: " + suggestion.reason,
        createdAt: new Date().toISOString()
      });
    }
  }

  saveDb(db);
  res.json(suggestion);
});

app.delete("/api/suggestions/:id", (req, res) => {
  const db = loadDb();
  db.suggestions = db.suggestions.filter((s) => s.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// 순위 체크(통합검색/카페 탭) — 카페 모니터링과 별개 모듈
require("./rank-tracker/routes").mount(app, DATA_DIR);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`keyword-research-board listening on port ${PORT}`);
});
