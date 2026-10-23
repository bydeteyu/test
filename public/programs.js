// 프로그램 목록(앱 메뉴) — 새 프로그램을 만들면 아래 PROGRAMS 에 한 줄만 추가하면
// 모든 화면의 좌측 상단 메뉴와 홈 화면 카드에 자동으로 나타난다.
//   id: 고유 이름 · icon: 이모지 · title: 이름 · desc: 한 줄 설명 · href: 주소 · adminOnly: true 면 관리자에게만 표시
(function () {
  const PROGRAMS = [
    { id: "rank", icon: "🏆", title: "순위 체크 (Naver 카페)", desc: "키워드 검색 → 통합·카페 순위와 콘텐츠 조회수를 매일 기록하고, 차트와 엑셀로 확인합니다.", href: "/rank.html" },
    { id: "threads", icon: "🧵", title: "순위 체크 (Threads)", desc: "연결한 Threads 계정의 게시글 조회수·좋아요·댓글을 매일 기록하고 증감 차트로 확인합니다.", href: "/threads.html" },
    { id: "research", icon: "🔍", title: "키워드 리서치 보드", desc: "클라이언트별 키워드 리서치·평가·채택, 카페 모니터링과 AI 키워드 확장을 관리합니다.", href: "/", adminOnly: true },
    { id: "admin", icon: "👥", title: "계정 관리", desc: "회원 계정을 만들고 볼 수 있는 프로젝트를 지정합니다.", href: "/admin.html", adminOnly: true },
    // 새 프로그램은 여기에 추가: { id: "new", icon: "📈", title: "이름", desc: "설명", href: "/new.html" },
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let mePromise = null;
  const getMe = () => (mePromise ??= fetch("/api/me").then((r) => (r.status === 401 ? (location.href = "/login.html", null) : r.json())).catch(() => ({ role: "admin" })));
  const visible = (me) => PROGRAMS.filter((p) => !(p.adminOnly && me && me.role === "viewer"));

  const CSS = `
  #appbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:12px;background:#1A1C2E;color:#fff;padding:0 18px;height:52px;margin:-20px -16px 18px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  #appbar .menu-btn{display:flex;align-items:center;gap:8px;background:transparent;border:0;color:#fff;font:inherit;font-weight:700;font-size:.95rem;cursor:pointer;padding:8px 10px;border-radius:9px}
  #appbar .menu-btn:hover,#appbar .menu-btn[aria-expanded="true"]{background:rgba(255,255,255,.12)}
  #appbar .cur{color:#9aa0b8;font-size:.9rem}
  #appbar .sp{flex:1}
  #appbar .who{font-size:.8rem;color:#aab0c8;white-space:nowrap}#appbar .who a{color:#fff;margin-left:10px}
  #appmenu{position:fixed;top:52px;left:0;right:0;bottom:0;z-index:49;background:rgba(14,16,28,.55);display:none}
  #appmenu.open{display:block}
  #appmenu .panel{max-width:760px;margin:0 0 0 12px;background:#fff;color:#1A1C2E;border-radius:0 0 16px 16px;box-shadow:0 12px 32px rgba(0,0,0,.28);padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
  #appmenu a.item{display:flex;flex-direction:column;gap:5px;text-decoration:none;color:inherit;background:#F1F2F6;border:2px solid transparent;border-radius:14px;padding:14px 15px}
  #appmenu a.item:hover{background:#E6F7EC}
  #appmenu a.item.cur{border-color:#03A94D;background:#E6F7EC}
  #appmenu .ico{font-size:1.6rem;line-height:1}#appmenu .t{font-weight:700;font-size:.95rem}#appmenu .d{font-size:.76rem;color:#6A6F85;line-height:1.45}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]) #appmenu .panel{background:#1E212E;color:#ECEEF6}:root:not([data-theme="light"]) #appmenu a.item{background:#2A2E40}:root:not([data-theme="light"]) #appmenu a.item:hover,:root:not([data-theme="light"]) #appmenu a.item.cur{background:#17382A}:root:not([data-theme="light"]) #appmenu .d{color:#9AA0B8}}
  `;

  // 화면 맨 위에 앱 바를 만든다. 왼쪽 버튼을 누르면 프로그램 목록이 펼쳐진다. currentId: 지금 화면의 프로그램 id
  async function mountBar(currentId) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const cur = PROGRAMS.find((p) => p.id === currentId);
    const bar = document.createElement("div");
    bar.id = "appbar";
    bar.innerHTML = `<button class="menu-btn" id="menuBtn" type="button" aria-expanded="false" aria-controls="appmenu">☰ <span>프로그램</span></button><span class="cur">${cur ? esc(cur.icon + " " + cur.title) : ""}</span><span class="sp"></span><span class="who" id="appwho"></span>`;
    document.body.prepend(bar);
    const menu = document.createElement("div");
    menu.id = "appmenu";
    document.body.appendChild(menu);
    const btn = bar.querySelector("#menuBtn");
    const toggle = (open) => { menu.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); };
    btn.addEventListener("click", () => toggle(!menu.classList.contains("open")));
    menu.addEventListener("click", (e) => { if (e.target === menu) toggle(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });
    const me = await getMe();
    menu.innerHTML = `<div class="panel">${visible(me).map((p) => `<a class="item${p.id === currentId ? " cur" : ""}" href="${esc(p.href)}"><span class="ico">${p.icon}</span><span class="t">${esc(p.title)}</span><span class="d">${esc(p.desc)}</span></a>`).join("")}</div>`;
    const who = bar.querySelector("#appwho");
    if (me && !me.openMode) {
      who.innerHTML = `${esc(me.name || me.username || "")} (${me.role === "viewer" ? "회원" : "관리자"}) <a href="#" id="appLogout">로그아웃</a>`;
      who.querySelector("#appLogout").addEventListener("click", async (e) => { e.preventDefault(); await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; });
    }
  }

  window.Programs = { list: PROGRAMS, visible, getMe, mountBar, esc };
})();
