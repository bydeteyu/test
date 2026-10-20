const test = require("node:test");
const assert = require("node:assert");
const JSZip = require("jszip");
const { buildWorkbook } = require("../xlsx");

const channels = [{ key: "integrated", label: "통합" }, { key: "cafe", label: "카페" }];
const item = (label, history) => ({ keyword: "키워드", label, history });

test("엑셀: 요약 시트 + 항목별 시트와 차트(막대+선, 보조 축)가 만들어진다", async () => {
  const history = {
    "2026-10-18": { integrated: { status: "hit", rank: 5, views: 1000 }, cafe: { status: "hit", rank: 15, views: 1000 } },
    "2026-10-19": { integrated: { status: "miss", views: 1100 }, cafe: { status: "hit", rank: 13, views: 1100 } },
    "2026-10-20": { integrated: { status: "hit", rank: 3, views: 1250 }, cafe: { status: "hit", rank: 12, views: 1250 } },
  };
  const buf = await buildWorkbook({ projectName: "교보라이프플래닛", items: [item("글 A", history), item("글 B: [특수]/문자?", {})], channels, maxRank: 30 });
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  for (const f of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml", "xl/charts/chart1.xml", "xl/drawings/drawing1.xml"]) assert.ok(names.includes(f), f);
  assert.ok(!names.includes("xl/charts/chart2.xml"), "기록이 없는 항목은 차트가 없다");
  const wb = await zip.file("xl/workbook.xml").async("string");
  assert.match(wb, /name="순위표"/);
  assert.ok(!/[\[\]:*?\/\\]/.test([...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]).join("")), "시트 이름에 금지 문자 없음");
  const chart = await zip.file("xl/charts/chart1.xml").async("string");
  assert.match(chart, /<c:barChart>/);
  assert.match(chart, /<c:lineChart>/);
  assert.match(chart, /<c:orientation val="maxMin"\/>/); // 순위 축은 1위가 위
  const sum = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sum, /<v>3<\/v>/); // 최종 순위
  assert.match(sum, /1,?250|<v>1250<\/v>/); // 최종 조회수
  assert.match(sum, /<v>150<\/v>/); // 전일 대비(1100 → 1250)
  const s2 = await zip.file("xl/worksheets/sheet2.xml").async("string");
  assert.match(s2, /<v>100<\/v>/); // 일별 증가(1000 → 1100)
  assert.match(s2, /<drawing r:id="rId1"\/>/);
});

test("엑셀: 같은 이름의 항목도 시트 이름이 겹치지 않는다", async () => {
  const buf = await buildWorkbook({ items: [item("같은 이름", {}), item("같은 이름", {})], channels, maxRank: 30 });
  const wb = await (await JSZip.loadAsync(buf)).file("xl/workbook.xml").async("string");
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1].toLowerCase());
  assert.strictEqual(new Set(names).size, names.length);
});
