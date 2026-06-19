/* ── 전역 상태 ─────────────────────────────────────── */
let chartScore = null;
let chartTrend = null;
let chartComp  = null;
let currentData = null;

/* ── 진입점 ────────────────────────────────────────── */
document.getElementById('keyword-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startResearch();
});

function startResearch() {
  const raw = document.getElementById('keyword-input').value.trim();
  if (!raw) return;

  resetUI();
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('search-btn').disabled = true;

  const url = `/api/research?keywords=${encodeURIComponent(raw)}`;
  const es = new EventSource(url);

  es.onmessage = e => {
    const event = JSON.parse(e.data);
    handleEvent(event);
    if (event.step === 5 || event.step === -1) {
      es.close();
      document.getElementById('search-btn').disabled = false;
    }
  };
  es.onerror = () => {
    es.close();
    document.getElementById('search-btn').disabled = false;
    setStepError('연결 오류가 발생했습니다.');
  };
}

/* ── SSE 이벤트 처리 ─────────────────────────────── */
function handleEvent(event) {
  const { step, message, data } = event;

  if (step >= 1 && step <= 4) {
    activateStep(step, message);
  } else if (step === 5) {
    // 모든 스텝 완료 처리
    [1,2,3,4].forEach(s => markStepDone(s));
    if (data) renderDashboard(data);
  } else if (step === -1) {
    setStepError(message);
  }
}

function activateStep(n, msg) {
  // 이전 스텝들 done 처리
  for (let i = 1; i < n; i++) markStepDone(i);

  const el = document.getElementById(`step-${n}`);
  el.classList.add('active');
  el.classList.remove('done');
  document.getElementById(`msg-${n}`).textContent = msg;
}

function markStepDone(n) {
  const el = document.getElementById(`step-${n}`);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}

function setStepError(msg) {
  const msgEls = document.querySelectorAll('.step-msg');
  msgEls.forEach(el => { if (!el.textContent) el.textContent = msg; });
}

/* ── 대시보드 렌더링 ─────────────────────────────── */
function renderDashboard(data) {
  currentData = data;
  document.getElementById('result-section').classList.remove('hidden');

  // 요약 카드
  document.getElementById('stat-total').textContent = data.total.toLocaleString();
  document.getElementById('stat-top').textContent = data.keywords.length;
  const rising = data.all_scored.filter(k => k.trend_label === '상승').length;
  document.getElementById('stat-rising').textContent = rising;
  document.getElementById('stat-time').textContent = data.generated_at;

  renderScoreChart(data.keywords.slice(0, 10));
  renderTrendChart(data.all_scored);
  renderCompChart(data.all_scored);
  renderTable(data.keywords);
}

/* Chart: TOP 10 기회 점수 */
function renderScoreChart(keywords) {
  const ctx = document.getElementById('chart-score').getContext('2d');
  if (chartScore) chartScore.destroy();
  chartScore = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: keywords.map(k => k.keyword),
      datasets: [{
        label: '기회 점수',
        data: keywords.map(k => k.opportunity_score),
        backgroundColor: keywords.map((_, i) =>
          `hsla(${240 + i * 8}, 80%, 65%, 0.85)`
        ),
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { color: '#2d3148' },
          ticks: { color: '#8890a8' },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#e8eaf0', font: { size: 12 } },
        }
      }
    }
  });
}

/* Chart: 트렌드 분포 (도넛) */
function renderTrendChart(all) {
  const counts = { 상승: 0, 안정: 0, 계절성: 0, 하락: 0 };
  all.forEach(k => { if (counts[k.trend_label] !== undefined) counts[k.trend_label]++; });
  const ctx = document.getElementById('chart-trend').getContext('2d');
  if (chartTrend) chartTrend.destroy();
  chartTrend = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: ['#00d4aa', '#6c63ff', '#f9a825', '#ff6b6b'],
        borderWidth: 0,
        hoverOffset: 6,
      }]
    },
    options: {
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8890a8', padding: 12, font: { size: 12 } }
        }
      }
    }
  });
}

/* Chart: 경쟁도 분포 (도넛) */
function renderCompChart(all) {
  const counts = { 낮음: 0, 중간: 0, 높음: 0 };
  all.forEach(k => { if (counts[k.comp_idx] !== undefined) counts[k.comp_idx]++; });
  const ctx = document.getElementById('chart-comp').getContext('2d');
  if (chartComp) chartComp.destroy();
  chartComp = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: ['#00d4aa', '#f9a825', '#ff6b6b'],
        borderWidth: 0,
        hoverOffset: 6,
      }]
    },
    options: {
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8890a8', padding: 12, font: { size: 12 } }
        }
      }
    }
  });
}

/* 테이블 */
function renderTable(keywords) {
  const maxScore = keywords[0]?.opportunity_score || 1;
  const tbody = document.getElementById('result-tbody');
  tbody.innerHTML = '';

  keywords.forEach(kw => {
    const trendBadge = trendBadgeHtml(kw.trend_label);
    const compBadge  = compBadgeHtml(kw.comp_idx);
    const barWidth   = Math.round((kw.opportunity_score / maxScore) * 100);
    const panelId    = `panel-${kw.rank}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rank-num">${kw.rank}</span></td>
      <td><span class="kw-main">${escHtml(kw.keyword)}</span></td>
      <td>${kw.monthly_total.toLocaleString()}</td>
      <td>${kw.monthly_pc.toLocaleString()}</td>
      <td>${kw.monthly_mobile.toLocaleString()}</td>
      <td>${compBadge}</td>
      <td>${trendBadge}</td>
      <td>
        <div class="score-bar-wrap">
          <div class="score-bar" style="width:${barWidth}px"></div>
          <span class="score-num">${kw.opportunity_score.toFixed(1)}</span>
        </div>
      </td>
      <td>
        <button class="expand-btn" onclick="togglePanel('${panelId}', this)">
          펼치기 ▾
        </button>
        <div class="expand-panel" id="${panelId}">
          <div class="expand-section">
            <strong>질문형</strong><br>
            ${kw.question_variants.map(v => `· ${escHtml(v)}`).join('<br>')}
          </div>
          <div class="expand-section">
            <strong>롱테일</strong><br>
            ${kw.longtail_variants.map(v => `· ${escHtml(v)}`).join('<br>')}
          </div>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/* ── 헬퍼 ────────────────────────────────────────── */
function trendBadgeHtml(label) {
  const map = { 상승: 'rising', 안정: 'stable', 계절성: 'seasonal', 하락: 'falling' };
  const cls = map[label] || 'stable';
  return `<span class="badge badge-${cls}">${label || '—'}</span>`;
}
function compBadgeHtml(label) {
  const map = { 낮음: 'low', 중간: 'mid', 높음: 'high' };
  const cls = map[label] || 'mid';
  return `<span class="badge badge-${cls}">${label || '—'}</span>`;
}
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function togglePanel(id, btn) {
  const panel = document.getElementById(id);
  panel.classList.toggle('open');
  btn.textContent = panel.classList.contains('open') ? '접기 ▴' : '펼치기 ▾';
}

/* ── CSV 내보내기 ────────────────────────────────── */
function exportCSV() {
  if (!currentData) return;
  const rows = [
    ['순위','키워드','월검색량','PC','모바일','경쟁도','트렌드','기회점수','질문형','롱테일']
  ];
  currentData.keywords.forEach(k => {
    rows.push([
      k.rank, k.keyword, k.monthly_total, k.monthly_pc, k.monthly_mobile,
      k.comp_idx, k.trend_label, k.opportunity_score,
      k.question_variants.join(' | '), k.longtail_variants.join(' | ')
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `keywords_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── UI 초기화 ───────────────────────────────────── */
function resetUI() {
  [1,2,3,4].forEach(n => {
    const el = document.getElementById(`step-${n}`);
    el.classList.remove('active', 'done');
    document.getElementById(`msg-${n}`).textContent = '';
  });
  document.getElementById('result-tbody').innerHTML = '';
  [chartScore, chartTrend, chartComp].forEach(c => c && c.destroy());
  chartScore = chartTrend = chartComp = null;
}
