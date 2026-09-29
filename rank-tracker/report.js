// history.csv → 날짜별 순위표(report.html). 행: 키워드·채널·대상, 열: 날짜.
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 셀 표기: "통합 5위 / 카페 16위", 범위 밖이면 "카페 20위 밖", 조회 실패는 "카페 -"
function writeReport(csvPath, outPath, channels, maxRank = 20) {
  const [, ...data] = parseCsv(fs.readFileSync(csvPath, "utf8")).filter((r) => r.length > 1);
  const dates = [...new Set(data.map((r) => r[0]))].sort().reverse();
  const groups = new Map();
  for (const [date, keyword, channel, target, exposed, rank] of data) {
    const k = [keyword, target].join("\u0000");
    if (!groups.has(k)) groups.set(k, { keyword, target, byDate: {} });
    ((groups.get(k).byDate[date] ??= {})[channel]) = { exposed, rank };
  }
  const cell = (d) => {
    if (!d) return '<td class="na">-</td>';
    const parts = Object.keys(channels).map((c) => {
      const v = d[c];
      const label = channels[c].label;
      if (!v || v.exposed === "") return `${label} -`;
      return v.exposed === "Y" ? `${label} ${v.rank}위` : `${label} ${maxRank}위 밖`;
    });
    const anyHit = Object.values(d).some((v) => v.exposed === "Y");
    return `<td class="${anyHit ? "hit" : "miss"}">${esc(parts.join(" / "))}</td>`;
  };
  const body = [...groups.values()]
    .sort((a, b) => a.keyword.localeCompare(b.keyword) || a.target.localeCompare(b.target))
    .map((g) => `<tr><td>${esc(g.keyword)}</td><td>${esc(g.target)}</td>${dates.map((d) => cell(g.byDate[d])).join("")}</tr>`)
    .join("\n");
  fs.writeFileSync(outPath, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>네이버 순위표</title>
<style>body{font:14px sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:center;white-space:nowrap}
th{background:#f3f3f3}td:nth-child(-n+2){text-align:left}.hit{background:#e6f7e6;font-weight:bold}.miss{color:#b00;background:#fdeeee}.na{color:#999}</style>
<h1>네이버 노출·순위표 <small>(검색 범위 ${maxRank}위까지)</small></h1><table><tr><th>키워드</th><th>대상</th>${dates.map((d) => `<th>${d}</th>`).join("")}</tr>
${body}</table></html>`);
}

module.exports = { writeReport, parseCsv };
