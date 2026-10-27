// Threads 게시글 화면(로그인된 Chrome)에서 조회수·좋아요·댓글·리포스트·공유 수를 읽는다.
// 이 함수는 화면 안에서 실행되므로 바깥 변수를 쓰지 않고 스스로 완결되어야 한다.
// 글 아래 아이콘에는 이름표(aria-label)가 없으므로 "화면에서의 위치"로 찾는다:
//  "조회 N회" 제목 아래 ~ 정렬 아이콘 위 구간에서 아이콘 3~5개가 한 줄로 늘어선 곳이 버튼 줄이고,
//  같은 줄에 있는 숫자 글자를 왼쪽 아이콘부터 (좋아요·댓글·리포스트·공유)에 연결한다. 숫자가 없는 아이콘은 0.
function readThreadsPage() {
  const toN = (n, u) => {
    const v = parseFloat(String(n).replace(/,/g, ""));
    if (!Number.isFinite(v)) return null;
    const mul = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, m: 1e6 }[String(u || "").toLowerCase()] || 1;
    return Math.round(v * mul);
  };
  const text = document.body ? document.body.innerText : "";
  const loggedIn = !/Threads에 로그인 또는 가입하기|Log in or sign up for Threads/i.test(text);
  let m = /조회\s*([\d][\d,.]*)\s*(천|만|억|[KkMm])?\s*회/.exec(text) || /([\d][\d,.]*)\s*([KkMm])?\s*views?\b/i.exec(text);
  const views = m ? toN(m[1], m[2]) : null;

  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) textNodes.push(n);
  const rectOfText = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect(); };

  // 1) 위쪽 경계: "조회 N회" 글자의 아래쪽, 아래쪽 경계: 정렬/활동 보기 아이콘(댓글 영역 시작)
  const head = textNodes.find((n) => /조회\s*\d|\d\s*views?\\b/i.test(n.nodeValue));
  const top = head ? rectOfText(head).bottom : 0;
  const stop = [...document.querySelectorAll("svg[aria-label]")].filter((s) => /^(정렬|활동 보기|sort|view activity)$/i.test((s.getAttribute("aria-label") || "").trim())).map((s) => s.getBoundingClientRect().top).filter((y) => y > top);
  const bottom = stop.length ? Math.min(...stop) : Infinity;

  // 2) 그 구간의 작은 아이콘들을 같은 높이끼리 묶는다
  const icons = [...document.querySelectorAll("svg")].map((s) => ({ s, r: s.getBoundingClientRect() })).filter(({ r }) => r.width >= 12 && r.width <= 40 && r.height >= 12 && r.height <= 40 && r.top > top - 2 && r.bottom <= bottom + 2);
  const rows = [];
  for (const ic of icons.sort((a, b) => a.r.top - b.r.top)) {
    const cy = (ic.r.top + ic.r.bottom) / 2;
    const row = rows.find((x) => Math.abs(x.cy - cy) < 8);
    if (row) row.items.push(ic); else rows.push({ cy, items: [ic] });
  }
  // 같은 높이라도 가로로 멀리 떨어진 아이콘(왼쪽 메뉴 등)은 다른 묶음으로 나눈다. 글 영역 왼쪽 바깥의 묶음은 제외한다.
  const leftEdge = head ? rectOfText(head).left - 120 : -Infinity;
  const groups = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.r.left - b.r.left);
    let cur = [];
    for (const ic of sorted) {
      if (cur.length && ic.r.left - cur[cur.length - 1].r.right > 100) { groups.push({ cy: row.cy, items: cur }); cur = []; }
      cur.push(ic);
    }
    if (cur.length) groups.push({ cy: row.cy, items: cur });
  }
  const bars = groups.filter((x) => x.items.length >= 3 && x.items.length <= 5 && x.items[0].r.left >= leftEdge).sort((a, b) => b.cy - a.cy); // 가장 아래(= 글 본문 바로 아래)
  const bar = bars[0] || null;

  const out = {};
  const nums = [];
  if (bar) {
    const items = bar.items.sort((a, b) => a.r.left - b.r.left);
    const band = [Math.min(...items.map((i) => i.r.top)) - 8, Math.max(...items.map((i) => i.r.bottom)) + 8];
    // 숫자는 아이콘 바로 오른쪽에 붙어 있을 때만 그 아이콘의 숫자로 인정한다(같은 높이의 다른 영역 숫자는 무시)
    const lastRight = items[items.length - 1].r.right;
    for (const n of textNodes) {
      const t = n.nodeValue.trim();
      const mm = /^([\d][\d,.]*)\s*(천|만|억|[KkMm])?$/.exec(t);
      if (!mm) continue;
      const r = rectOfText(n);
      if (r.top < band[0] || r.bottom > band[1] || r.left < items[0].r.left || r.left > lastRight + 80) continue;
      const idx = items.findIndex((ic, i) => r.left >= ic.r.right - 6 && (i === items.length - 1 ? r.left <= ic.r.right + 80 : r.left < items[i + 1].r.left - 2));
      if (idx >= 0) nums.push({ t, x: Math.round(r.left), v: toN(mm[1], mm[2]), icon: idx });
    }
    const keys = ["likes", "replies", "reposts", "shares"];
    items.forEach((ic, idx) => { if (keys[idx]) out[keys[idx]] = 0; });
    for (const nn of nums) if (keys[nn.icon]) out[keys[nn.icon]] = nn.v;
  }
  // 본문: 제목("조회 N회") 아래 ~ 버튼 줄 위에 있는 글자에서 아이디·시간·숫자·메뉴 줄을 빼고 이어 붙인다
  let body = "";
  if (bar) {
    const barTop = Math.min(...bar.items.map((i) => i.r.top));
    const skip = /^[\w.]+$|^[\d,.]+\s*(천|만|억|[KkMm])?$|^\d+\s*(초|분|시간|일|주)$|^(수정됨|번역 보기|더 보기|팔로우|스레드)$/;
    body = textNodes.filter((n) => { const r = rectOfText(n); return r.top > top && r.bottom <= barTop + 2 && r.left >= leftEdge; })
      .map((n) => n.nodeValue.trim()).filter((t) => t && !skip.test(t)).join(" ").replace(/\s+/g, " ").slice(0, 200);
  }
  const labels = [...new Set([...document.querySelectorAll("svg[aria-label]")].map((s) => (s.getAttribute("aria-label") || "").trim()))].slice(0, 40);
  return { views, ...out, text: body, loggedIn, foundBar: !!bar, iconCount: bar ? bar.items.length : 0, numbers: nums, bounds: { top: Math.round(top), bottom: Number.isFinite(bottom) ? Math.round(bottom) : null }, labels, url: location.href };
}
