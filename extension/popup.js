const $ = (s) => document.querySelector(s);
async function show() {
  const c = await chrome.storage.local.get(["server", "lastRunDate", "lastStatus"]);
  const s = c.lastStatus;
  $("#st").textContent = !c.server ? "설정이 필요합니다(설정 버튼)." : `서버: ${c.server}\n마지막 실행: ${c.lastRunDate || "아직 없음"}` + (s ? `\n성공 ${s.ok} · 실패 ${s.fail}${s.noLogin ? ` · 로그인 필요 ${s.noLogin}` : ""}${s.errors.length ? "\n" + s.errors.slice(0, 3).join("\n") : ""}` : "");
  $("#st").style.whiteSpace = "pre-wrap";
}
$("#opt").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#run").addEventListener("click", async () => {
  $("#run").disabled = true; $("#run").textContent = "실행 중… (탭이 잠깐씩 열립니다)";
  await chrome.runtime.sendMessage({ type: "run" });
  $("#run").disabled = false; $("#run").textContent = "지금 실행"; show();
});
$("#test").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const out = $("#out"); out.hidden = false;
  try { const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["reader.js"] }).then(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => readThreadsPage() })); out.textContent = JSON.stringify(r.result, null, 2); }
  catch (e) { out.textContent = "이 탭은 읽을 수 없습니다: " + e.message; }
});
show();
