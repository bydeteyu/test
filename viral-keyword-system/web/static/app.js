/* 써큐톡스 황금 키워드 대시보드 */

let currentJobId = null;
let currentDate = null;
let rawVisible = false;

// ── 화면 전환 ───────────────────────────────────────────────────────────────

function showWelcome() {
  document.getElementById('welcomeScreen').classList.remove('hidden');
  document.getElementById('progressScreen').classList.add('hidden');
  document.getElementById('reportScreen').classList.add('hidden');
  setActiveHistory(null);
}

function showProgress() {
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('progressScreen').classList.remove('hidden');
  document.getElementById('reportScreen').classList.add('hidden');
}

function showReport() {
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('progressScreen').classList.add('hidden');
  document.getElementById('reportScreen').classList.remove('hidden');
}

// ── 리서치 시작 ─────────────────────────────────────────────────────────────

async function startRun() {
  const btn = document.getElementById('runBtn');
  const raw = document.getElementById('keywordInput').value.trim();
  const useCache = document.getElementById('useCacheCheck').checked;

  const keywords = raw
    ? raw.split('\n').map(k => k.trim()).filter(Boolean)
    : [];

  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> 진행 중…';

  resetProgress();
  showProgress();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords, use_cache: useCache }),
    });
    const { job_id } = await res.json();
    currentJobId = job_id;
    listenStream(job_id);
  } catch (e) {
    addLog('ERROR', '서버 연결 실패: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">▶</span> 리서치 시작';
  }
}

// ── SSE 스트림 ───────────────────────────────────────────────────────────────

function listenStream(jobId) {
  const es = new EventSource(`/api/stream/${jobId}`);

  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);

    if (ev.type === 'heartbeat') return;

    if (ev.type === 'log') {
      addLog(ev.level, ev.msg);
    }

    if (ev.type === 'progress') {
      updateProgress(ev.step, ev.msg, ev.pct);
      addLog('progress', `[${ev.step}] ${ev.msg}`);
    }

    if (ev.type === 'done') {
      es.close();
      updateProgress('report', '완료!', 100);
      addLog('progress', '✅ 리포트 생성 완료: ' + ev.path);

      const date = ev.path.replace('.md', '');
      setTimeout(() => {
        loadReport(date, true);
        resetBtn();
      }, 800);
    }

    if (ev.type === 'error') {
      es.close();
      addLog('ERROR', '오류 발생: ' + ev.msg);
      resetBtn();
    }
  };

  es.onerror = () => {
    addLog('ERROR', 'SSE 연결 끊김');
    es.close();
    resetBtn();
  };
}

// ── 진행 UI ──────────────────────────────────────────────────────────────────

const STEP_ORDER = ['collect', 'analyze', 'generate', 'report'];

function resetProgress() {
  document.getElementById('progressTitle').textContent = '리서치 진행 중…';
  document.getElementById('progressSub').textContent = '데이터 수집 시작';
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressPct').textContent = '0%';
  document.getElementById('logBox').innerHTML = '';
  STEP_ORDER.forEach(s => {
    const el = document.getElementById('si-' + s);
    if (el) el.className = 'step-ind';
  });
}

function updateProgress(step, msg, pct) {
  document.getElementById('progressTitle').textContent = msg;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';

  const stepIdx = STEP_ORDER.indexOf(step);
  STEP_ORDER.forEach((s, i) => {
    const el = document.getElementById('si-' + s);
    if (!el) return;
    if (i < stepIdx) el.className = 'step-ind done';
    else if (i === stepIdx) el.className = 'step-ind active';
    else el.className = 'step-ind';
  });
}

function addLog(level, msg) {
  const box = document.getElementById('logBox');
  const line = document.createElement('div');
  line.className = 'log-entry ' + level;
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  line.textContent = `${time}  ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function resetBtn() {
  const btn = document.getElementById('runBtn');
  btn.disabled = false;
  btn.innerHTML = '<span class="btn-icon">▶</span> 리서치 시작';
}

// ── 리포트 로드 ──────────────────────────────────────────────────────────────

async function loadReport(dateStr, isNew = false) {
  try {
    const res = await fetch(`/api/report/${dateStr}`);
    if (!res.ok) { alert('리포트를 불러올 수 없습니다.'); return; }
    const { html, raw } = await res.json();

    currentDate = dateStr;
    rawVisible = false;

    document.getElementById('reportDateLabel').textContent = '📄 ' + dateStr;
    document.getElementById('reportContent').innerHTML = html;
    document.getElementById('reportContent').classList.remove('hidden');
    document.getElementById('reportRaw').textContent = raw;
    document.getElementById('reportRaw').classList.add('hidden');

    showReport();
    setActiveHistory(dateStr);

    if (isNew) refreshHistory();
  } catch (e) {
    alert('리포트 로드 실패: ' + e.message);
  }
}

function toggleRaw() {
  rawVisible = !rawVisible;
  document.getElementById('reportContent').classList.toggle('hidden', rawVisible);
  document.getElementById('reportRaw').classList.toggle('hidden', !rawVisible);
  document.querySelector('.btn-raw').textContent = rawVisible ? '🖥 렌더링 보기' : '📋 원본 보기';
}

// ── 히스토리 ─────────────────────────────────────────────────────────────────

function setActiveHistory(dateStr) {
  document.querySelectorAll('.history-item').forEach(el => {
    el.classList.toggle('active', el.dataset.date === dateStr);
  });
}

async function refreshHistory() {
  try {
    const res = await fetch('/api/reports');
    const { reports } = await res.json();
    const list = document.getElementById('historyList');
    list.innerHTML = reports.map(d =>
      `<li class="history-item${d === currentDate ? ' active' : ''}"
           data-date="${d}"
           onclick="loadReport('${d}')">
        <span class="history-icon">📄</span> ${d}
      </li>`
    ).join('') || '<li class="history-empty">리포트 없음</li>';
  } catch (_) {}
}

// ── 초기화 ───────────────────────────────────────────────────────────────────

document.querySelectorAll('.history-item').forEach(el => {
  // dataset.date 설정 (Jinja에서 onclick 문자열로만 세팅됨)
  const m = el.getAttribute('onclick')?.match(/'([^']+)'/);
  if (m) el.dataset.date = m[1];
});
