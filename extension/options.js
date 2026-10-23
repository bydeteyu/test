const $ = (s) => document.querySelector(s);
chrome.storage.local.get(["server", "key", "hour"]).then((c) => { $("#server").value = c.server || ""; $("#key").value = c.key || ""; $("#hour").value = c.hour ?? 9; });
$("#save").addEventListener("click", async () => {
  const msg = $("#msg");
  try {
    const server = $("#server").value.trim().replace(/\/+$/, "");
    const u = new URL(server);
    const ok = await chrome.permissions.request({ origins: [u.origin + "/*"] }); // 이 서버에만 접속 허용을 요청한다
    if (!ok) throw new Error("서버 접속 권한을 허용해야 합니다.");
    const key = $("#key").value.trim();
    const res = await fetch(u.origin + "/api/threads/ext/tasks", { headers: { "X-Ext-Key": key } });
    if (!res.ok) throw new Error(res.status === 401 ? "키가 올바르지 않습니다." : `서버 응답 오류(HTTP ${res.status})`);
    const d = await res.json();
    await chrome.storage.local.set({ server: u.origin, key, hour: Number($("#hour").value) || 9 });
    msg.style.color = "#1F7A4D";
    msg.textContent = `저장했습니다. 수집 대상 글 ${d.posts.length}개.`;
  } catch (e) { msg.style.color = "#AE4430"; msg.textContent = e.message; }
});
