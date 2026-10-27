// 하루 한 번(KST 설정 시각 이후 첫 기회) 서버에 등록된 공개 링크 글을 차례로 열어 숫자를 읽어 보낸다.
importScripts("reader.js");

const kst = () => new Date(Date.now() + 9 * 3600e3);
const today = () => kst().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (k) => chrome.storage.local.get(k);
const set = (o) => chrome.storage.local.set(o);
let running = false;

async function api(cfg, path, body) {
  const res = await fetch(cfg.server.replace(/\/+$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: { "X-Ext-Key": cfg.key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `서버 응답 오류(HTTP ${res.status})`);
  return data;
}

function waitLoaded(tabId, ms = 30000) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); }
    function on(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }).catch(done);
  });
}
// 글이 자바스크립트로 그려질 때까지 몇 번 다시 읽는다
async function readTab(tabId) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    await sleep(i ? 1500 : 2500);
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readThreadsPage });
    last = r && r.result;
    if (last && last.views != null && (last.foundBar || !last.loggedIn || i >= 4)) break;
  }
  return last;
}

async function run() {
  if (running) return { busy: true };
  running = true;
  const cfg = await get(["server", "key"]);
  const status = { at: new Date().toISOString(), ok: 0, fail: 0, noLogin: 0, errors: [] };
  try {
    if (!cfg.server || !cfg.key) throw new Error("서버 주소와 키를 먼저 설정하세요(옵션).");
    const { posts } = await api(cfg, "/api/threads/ext/tasks");
    for (const p of posts) {
      let tabId = null;
      try {
        const tab = await chrome.tabs.create({ url: p.url, active: false });
        tabId = tab.id;
        await waitLoaded(tabId);
        const r = await readTab(tabId);
        if (!r || r.views == null) throw new Error("조회수를 읽지 못했습니다");
        if (!r.loggedIn) status.noLogin++;
        const body = { postId: p.id, views: r.views };
        if (r.loggedIn && r.text) body.text = r.text;
        if (r.loggedIn && r.foundBar) for (const k of ["likes", "replies", "reposts", "shares"]) if (r[k] != null) body[k] = r[k];
        await api(cfg, "/api/threads/ext/report", body);
        status.ok++;
      } catch (e) {
        status.fail++;
        status.errors.push(`${p.url.slice(-24)}: ${e.message}`);
      } finally {
        if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
      }
      await sleep(3000 + Math.random() * 4000); // 사람이 차례로 열어 보는 정도의 간격
    }
    await set({ lastRunDate: today() });
  } catch (e) {
    status.errors.push(e.message);
    status.fail++;
  } finally {
    running = false;
    await set({ lastStatus: status });
  }
  return status;
}

async function tick() {
  const cfg = await get(["server", "key", "hour", "lastRunDate"]);
  if (!cfg.server || !cfg.key || running) return;
  if (cfg.lastRunDate === today() || kst().getUTCHours() < Number(cfg.hour ?? 9)) return;
  await run();
}

chrome.alarms.create("tick", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tick") tick(); });
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg && msg.type === "run") { run().then(send); return true; }
  if (msg && msg.type === "state") { send({ running }); }
});
