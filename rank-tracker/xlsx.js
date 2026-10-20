// 순위표를 엑셀(.xlsx)로 만든다: 요약 시트 + 항목별 시트(표 + "더보기"와 같은 통합 차트).
// 외부 라이브러리는 압축용 jszip 뿐이고, 차트(막대=일별 조회수 증가 / 선=순위)는 OOXML 을 직접 만든다.
const JSZip = require("jszip");

const esc = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const colName = (i) => { let n = i + 1, s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// 스타일 번호: 0 기본, 1 헤더, 2 숫자(천 단위), 3 굵은 제목, 4 가운데, 5 순위(중앙·굵게), 6 증감(+/-)
const S = { base: 0, head: 1, num: 2, title: 3, center: 4, rank: 5, delta: 6 };
const STYLES = XML + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="+#,##0;-#,##0;0"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font><font><b/><sz val="14"/><name val="맑은 고딕"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0ECE3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFBBB5A6"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// rows: [[{v, s}|v|null, ...], ...]  (v 가 숫자면 숫자 셀, 문자열이면 문자 셀)
function sheetXml(rows, { widths = [], drawing = false, freeze = false } = {}) {
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const body = rows.map((row, r) => {
    const cells = row.map((c, i) => {
      if (c === null || c === undefined || c === "") return "";
      const { v, s = 0 } = typeof c === "object" ? c : { v: c };
      if (v === null || v === undefined || v === "") return "";
      const ref = colName(i) + (r + 1);
      return typeof v === "number" ? `<c r="${ref}" s="${s}"><v>${v}</v></c>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const view = freeze ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>' : '<sheetView workbookViewId="0"/>';
  return XML + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="16"/>${cols}<sheetData>${body}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawing ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
}

// ---- 데이터 가공 (화면의 순위표/더보기 차트와 같은 규칙) ----
function viewsFor(rec) { return rec && rec.views != null ? rec.views : null; }
function history(item, channels) {
  const dates = Object.keys(item.history || {}).sort();
  const out = [];
  let prev = null;
  for (const d of dates) {
    const h = item.history[d] || {};
    const views = channels.map((c) => viewsFor(h[c.key])).find((v) => v != null) ?? null;
    const diff = views != null && prev != null ? views - prev : null;
    if (views != null) prev = views;
    out.push({ date: d, ranks: channels.map((c) => (h[c.key] && h[c.key].status === "hit" && h[c.key].rank != null ? h[c.key].rank : null)), views, diff });
  }
  return out;
}
function statusText(rec, maxRank) {
  if (!rec || rec.status === "error") return "-";
  if (rec.status === "hit") return rec.rank != null ? rec.rank : "노출";
  return `${maxRank}위 밖`;
}

// ---- 차트: 막대(일별 조회수 증가, 오른쪽 축) + 선(순위, 왼쪽 축, 1위가 위) ----
const COLORS = { bar: "1BAF7A", lines: ["2A78D6", "EB6834"] };
function strCache(vals) { return `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache>`; }
function numCache(vals) { return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`; }
const axTitle = (t, rot) => `<c:title><c:tx><c:rich><a:bodyPr${rot ? ' rot="-5400000" vert="horz"' : ""}/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000" b="1"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="1000" b="1"/><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

function chartXml(sheet, first, last, rows, channels, title) {
  const q = `'${sheet.replace(/'/g, "''")}'`;
  const rng = (col) => `${q}!$${col}$${first}:$${col}$${last}`;
  const dates = rows.map((r) => r.date);
  const cat = `<c:cat><c:strRef><c:f>${rng("A")}</c:f>${strCache(dates)}</c:strRef></c:cat>`;
  const barCol = colName(channels.length + 2); // 날짜, 채널 순위들, 조회수, 일별 증가
  const bar = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${q}!$${barCol}$${first - 1}</c:f>${strCache(["일별 조회수 증가"])}</c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${COLORS.bar}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:dLbls><c:numFmt formatCode="+#,##0;-#,##0;0" sourceLinked="0"/><c:spPr><a:noFill/></c:spPr><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>${cat}<c:val><c:numRef><c:f>${rng(barCol)}</c:f>${numCache(rows.map((r) => r.diff))}</c:numRef></c:val></c:ser><c:gapWidth val="80"/><c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>`;
  const lines = channels.map((c, i) => {
    const col = colName(i + 1), color = COLORS.lines[i % COLORS.lines.length];
    return `<c:ser><c:idx val="${i + 1}"/><c:order val="${i + 1}"/><c:tx><c:strRef><c:f>${q}!$${col}$${first - 1}</c:f>${strCache([`${c.label} 순위`])}</c:strRef></c:tx><c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>${cat}<c:val><c:numRef><c:f>${rng(col)}</c:f>${numCache(rows.map((r) => r.ranks[i]))}</c:numRef></c:val><c:smooth val="0"/></c:ser>`;
  }).join("");
  const line = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lines}<c:marker val="1"/><c:axId val="60010001"/><c:axId val="60010002"/></c:lineChart>`;
  const axes =
    `<c:catAx><c:axId val="50010001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="50010002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="r"/>${axTitle("일별 조회수 증가", true)}<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010001"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>` +
    `<c:valAx><c:axId val="60010002"/><c:scaling><c:orientation val="maxMin"/><c:min val="1"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="DDD6C8"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>${axTitle("순위 (1위가 위)", true)}<c:numFmt formatCode="0&quot;위&quot;" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="60010001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>` +
    `<c:catAx><c:axId val="60010001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="60010002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  return XML + `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="1200" b="1"/><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${bar}${line}${axes}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
const drawingXml = (name, col) => XML + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 11}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${esc(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
const rels = (items) => XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;

// 시트 이름: 31자 이하, 특수문자 제거, 중복 방지
function sheetName(base, used) {
  let n = String(base).replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "항목";
  let name = n, k = 2;
  while (used.has(name.toLowerCase())) name = `${n.slice(0, 26)} ${k++}`;
  used.add(name.toLowerCase());
  return name;
}

// items: [{keyword,label,history}], channels: [{key,label}]
async function buildWorkbook({ projectName = "", items = [], channels = [], maxRank = 30 }) {
  const zip = new JSZip();
  const used = new Set(["순위표"]);
  const sheets = []; // { name, xml, drawingIdx }
  let nDraw = 0;

  // 1) 요약: 화면의 순위표와 같은 내용(항목마다 가장 최근 기록)
  const head = ["키워드", "콘텐츠", "최종 조회일"];
  for (const c of channels) head.push(`${c.label} 순위`, `${c.label} 조회수`, `${c.label} 전일 대비`);
  const sumRows = [head.map((h) => ({ v: h, s: S.head }))];
  for (const it of items) {
    const dates = Object.keys(it.history || {}).sort();
    const last = dates[dates.length - 1];
    const hist = history(it, channels);
    const row = [it.keyword, it.label || it.titleContains || it.match, { v: last || "-", s: S.center }];
    channels.forEach((c) => {
      const rec = last ? it.history[last][c.key] : null;
      const st = statusText(rec, maxRank);
      row.push({ v: st, s: S.rank });
      row.push({ v: viewsFor(rec), s: S.num });
      // 전일 대비: 이 채널의 직전 기록 대비
      let diff = null;
      if (rec && rec.views != null) { for (let i = dates.length - 2; i >= 0; i--) { const p = viewsFor(it.history[dates[i]][c.key]); if (p != null) { diff = rec.views - p; break; } } }
      row.push({ v: diff, s: S.delta });
    });
    sumRows.push(row);
  }
  sheets.push({ name: "순위표", xml: sheetXml(sumRows, { widths: [26, 46, 13, ...channels.flatMap(() => [12, 12, 12])], freeze: true }) });

  // 2) 항목별 시트: 날짜별 기록 + 더보기와 같은 차트
  const colsPerSheet = channels.length + 3; // 날짜, 순위들, 조회수, 일별 증가
  items.forEach((it, idx) => {
    const name = sheetName(`${idx + 1}. ${it.label || it.keyword}`, used);
    const rows = history(it, channels);
    const FIRST = 5; // 데이터 시작 행(1부터)
    const top = [[{ v: `${projectName ? projectName + " · " : ""}${it.label || it.keyword}`, s: S.title }], [{ v: "검색 키워드", s: S.head }, it.keyword], [], [{ v: "날짜", s: S.head }, ...channels.map((c) => ({ v: `${c.label} 순위`, s: S.head })), { v: "조회수", s: S.head }, { v: "일별 조회수 증가", s: S.head }]];
    // 헤더가 4행이므로 데이터는 5행부터. (차트 시리즈 이름은 헤더 행을 가리킨다)
    const body = rows.map((r) => [{ v: r.date, s: S.center }, ...r.ranks.map((x) => ({ v: x, s: S.rank })), { v: r.views, s: S.num }, { v: r.diff, s: S.delta }]);
    const hasChart = rows.length > 0;
    const sheet = { name, xml: sheetXml([...top, ...body], { widths: [13, ...channels.map(() => 12), 12, 16], drawing: hasChart }) };
    if (hasChart) {
      nDraw += 1;
      sheet.draw = nDraw;
      zip.file(`xl/drawings/drawing${nDraw}.xml`, drawingXml(`차트 ${nDraw}`, colsPerSheet + 1));
      zip.file(`xl/drawings/_rels/drawing${nDraw}.xml.rels`, rels([["rId1", "chart", `../charts/chart${nDraw}.xml`]]));
      zip.file(`xl/charts/chart${nDraw}.xml`, chartXml(name, FIRST, FIRST + rows.length - 1, rows, channels, `${it.label || it.keyword} · 순위 추이와 일별 조회수 증가`));
    }
    sheets.push(sheet);
  });

  sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.xml);
    if (s.draw) zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, rels([["rId1", "drawing", `../drawings/drawing${s.draw}.xml`]]));
  });
  zip.file("xl/styles.xml", STYLES);
  zip.file("xl/workbook.xml", XML + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029"/></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", rels([...sheets.map((s, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]), [`rId${sheets.length + 1}`, "styles", "styles.xml"]]));
  zip.file("_rels/.rels", rels([["rId1", "officeDocument", "xl/workbook.xml"]]));
  const ct = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)];
  for (let k = 1; k <= nDraw; k++) ct.push(`<Override PartName="/xl/drawings/drawing${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`, `<Override PartName="/xl/charts/chart${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
  zip.file("[Content_Types].xml", XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join("")}</Types>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { buildWorkbook };
