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

function writeReport(csvPath, outPath, channels) {
  const [, ...data] = parseCsv(fs.readFileSync(csvPath, "utf8")).filter((r) => r.length > 1);
  const dates = [...new Set(data.map((r) => r[0]))].sort().reverse();
  const groups = new Map();
  for (const [date, keyword, channel, target, exposed, rank] of data) {
    const k = [keyword, channel, target].join("\u0000");
    if (!groups.has(k)) groups.set(k, { keyword, channel, target, byDate: {} });
    groups.get(k).byDate[date] = { exposed, rank };
  }
  const cell = (v) => {
    if (!v || v.exposed === "") return '<td class="na">-</td>';
    if (v.exposed === "N") return '<td class="miss">미노출</td>';
    return `<td class="hit">${esc(v.rank)}위</td>`;
  };
  const body = [...groups.values()]
    .sort((a, b) => a.keyword.localeCompare(b.keyword) || a.channel.localeCompare(b.channel))
    .map((g) => `<tr><td>${esc(g.keyword)}</td><td>${esc(channels[g.channel]?.label ?? g.channel)}</td><td>${esc(g.target)}</td>${dates.map((d) => cell(g.byDate[d])).join("")}</tr>`)
    .join("\n");
  fs.writeFileSync(outPath, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>네이버 순위표</title>
<style>body{font:14px sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:center}
th{background:#f3f3f3}td:nth-child(-n+3){text-align:left}.hit{background:#e6f7e6;font-weight:bold}.miss{color:#b00;background:#fdeeee}.na{color:#999}</style>
<h1>네이버 노출·순위표</h1><table><tr><th>키워드</th><th>채널</th><th>대상</th>${dates.map((d) => `<th>${d}</th>`).join("")}</tr>
${body}</table></html>`);
}

module.exports = { writeReport, parseCsv };
