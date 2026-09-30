#!/usr/bin/env node
// 사용법: node rank-tracker/track.js [config.json]
// 키워드별로 (1) 통합검색 (2) 카페 탭 순위를 확인해 rank-tracker/data/history.csv 에 누적하고 report.html 을 갱신한다.
const fs = require("fs");
const path = require("path");
const { CHANNELS, fetchKeyword, findTarget, today } = require("./core");
const { writeReport } = require("./report");

const DATA_DIR = process.env.RANK_DATA_DIR || path.join(__dirname, "data");
const HISTORY = path.join(DATA_DIR, "history.csv");

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function main() {
  const configPath = process.argv[2] || path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`설정 파일이 없습니다: ${configPath}\nrank-tracker/config.example.json 을 복사해 config.json 으로 만드세요.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const delayMs = config.delayMs ?? 3000;
  const maxRank = config.maxRank ?? 50;
  const date = today();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY)) fs.writeFileSync(HISTORY, "date,keyword,channel,target,exposed,rank,matched_title\n");

  const rows = [];
  for (const kw of config.keywords) {
    const fetched = await fetchKeyword(kw.keyword, { maxRank, delayMs });
    for (const [channel, ch] of Object.entries(CHANNELS)) {
      const posts = fetched[channel];
      if (posts && posts.length === 0) console.warn(`[경고] ${kw.keyword}/${ch.label}: 게시글 링크 0건 — 차단되었거나 페이지 구조가 바뀌었을 수 있음`);
      for (const t of kw.targets) {
        const hit = posts ? findTarget(posts, t, channel === "integrated" ? { pageText: posts.pageText } : {}) : null;
        // 조회 실패(posts===null)는 "미노출"과 구분해 빈 값으로 기록
        const exposed = posts === null ? "" : hit ? "Y" : "N";
        rows.push([date, kw.keyword, channel, t.label, exposed, hit ? (hit.rank ?? "") : "", hit ? hit.title : ""]);
        console.log(`${date} | ${kw.keyword} | ${ch.label} | ${t.label} | ${exposed === "" ? "조회실패" : hit ? (hit.rank == null ? "노출" : hit.rank + "위") : `${maxRank}위 밖`}`);
      }
    }
  }

  // 같은 날 재실행 시 중복 방지: 오늘자 행은 교체
  const kept = fs.readFileSync(HISTORY, "utf8").split("\n").filter((l, i) => l && (i === 0 || !l.startsWith(`${date},`)));
  fs.writeFileSync(HISTORY, kept.join("\n") + "\n" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  writeReport(HISTORY, path.join(DATA_DIR, "report.html"), CHANNELS, maxRank);
  console.log(`\n저장: ${HISTORY}\n순위표: ${path.join(DATA_DIR, "report.html")}`);
}

if (require.main === module) main();
