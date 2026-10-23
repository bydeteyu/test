// Threads 게시글 화면(로그인된 Chrome)에서 조회수·좋아요·댓글·리포스트·공유 수를 읽는다.
// 이 함수는 화면 안에서 실행되므로 바깥 변수를 쓰지 않고 스스로 완결되어야 한다.
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

  const label = (s) => (s.getAttribute("aria-label") || "").trim();
  const NAMES = [
    ["likes", /^(좋아요|좋아요 취소|likes?|unlike)$/i],
    ["replies", /^(답글|댓글|replies|reply|comment)$/i],
    ["reposts", /^(리포스트|reposts?)/i],
    ["shares", /^(공유|공유하기|share)/i],
  ];
  const all = [...document.querySelectorAll("svg[aria-label]")];
  const labels = [...new Set(all.map(label))].slice(0, 40);
  const small = (el) => el.getBoundingClientRect().height < 100;
  // 글 아래 버튼 줄: 화면에서 가장 먼저 나오는 작은 줄을 고른다(왼쪽 메뉴·아래쪽 댓글 줄은 제외).
  //  - 이름 기준: 좋아요·답글 아이콘이 함께 들어 있는 줄  - 순서 기준: 이름과 상관없이 아이콘 3~5개가 모인 줄
  let nameRow = null, orderRow = null;
  for (const svg of all.filter((x) => NAMES[0][1].test(label(x)))) {
    let el = svg;
    for (let i = 0; i < 8 && el && !nameRow; i++) {
      el = el.parentElement;
      if (el && small(el) && [...el.querySelectorAll("svg[aria-label]")].some((x) => NAMES[1][1].test(label(x)))) nameRow = el;
    }
    if (nameRow) break;
  }
  for (const svg of all) {
    let el = svg;
    for (let i = 0; i < 6 && el && !orderRow; i++) {
      el = el.parentElement;
      const n = el ? el.querySelectorAll("svg[aria-label]").length : 0;
      if (el && small(el) && n >= 3 && n <= 5 && !el.closest("nav")) orderRow = el;
    }
    if (orderRow) break;
  }
  let row = nameRow, byOrder = false;
  if (orderRow && (!nameRow || (orderRow !== nameRow && !!(nameRow.compareDocumentPosition(orderRow) & Node.DOCUMENT_POSITION_PRECEDING)))) { row = orderRow; byOrder = true; }
  const out = {};
  if (row) {
    const icons = [...row.querySelectorAll("svg[aria-label]")];
    NAMES.forEach(([k, re], idx) => {
      const svg = byOrder ? icons[idx] : icons.find((x) => re.test(label(x)));
      if (!svg) return;
      const btn = svg.closest('[role="button"]') || svg.parentElement;
      const mm = /([\d][\d,.]*)\s*(천|만|억|[KkMm])?/.exec(btn ? btn.innerText || "" : "");
      out[k] = mm ? toN(mm[1], mm[2]) : 0; // 0 이면 숫자가 그려지지 않는다
    });
  }
  return { views, ...out, loggedIn, foundBar: !!row, byOrder, labels, url: location.href };
}
