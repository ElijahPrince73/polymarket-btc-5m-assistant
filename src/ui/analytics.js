/* global Chart */

/**
 * Analytics and Optimizer tab rendering.
 * Follows existing vanilla JS patterns from script.js.
 *
 * - Tab navigation between Dashboard, Analytics, Optimizer
 * - Analytics tab: period tables, advanced metrics, drawdown chart
 * - Optimizer tab: parameter form, grid search, sortable results, apply/revert
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Tab Navigation ──────────────────────────────────────────────

  let activeTab = 'dashboard';
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  function switchTab(tabName) {
    activeTab = tabName;

    // Update button active state
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Show/hide tab content
    tabContents.forEach(content => {
      const isTarget = content.id === `tab-${tabName}`;
      content.classList.toggle('hidden', !isTarget);
    });

    // Expose activeTab globally for script.js polling guard
    window.__activeTab = tabName;

    // Fetch data for active tab
    if (tabName === 'analytics') {
      fetchAndRenderAnalytics();
    } else if (tabName === 'optimizer') {
      fetchCurrentConfig();
      checkRevertAvailable();
    }
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Initialize
  window.__activeTab = 'dashboard';

  // ── Period sub-tab navigation ───────────────────────────────────

  let activePeriod = 'day';
  let cachedAnalytics = null;

  const periodBtns = document.querySelectorAll('.period-tab-btn');
  periodBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activePeriod = btn.dataset.period;
      periodBtns.forEach(b => b.classList.toggle('active', b === btn));
      if (cachedAnalytics) renderPeriodTable(cachedAnalytics);
    });
  });

  // ── Analytics Tab ───────────────────────────────────────────────

  let drawdownChart = null;

  async function fetchAndRenderAnalytics() {
    try {
      const res = await fetch('/api/analytics');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Analytics fetch failed');
      cachedAnalytics = json.data;
      renderPeriodTable(cachedAnalytics);
      renderAdvancedMetrics(cachedAnalytics);
      renderDrawdownChart(cachedAnalytics);
    } catch (err) {
      const container = document.getElementById('period-table-container');
      if (container) container.innerHTML = `<p class="muted-text">Error: ${err.message}</p>`;
    }
  }

  function renderPeriodTable(data) {
    const container = document.getElementById('period-table-container');
    if (!container) return;

    let rows = [];
    if (activePeriod === 'day') {
      rows = data.byDay || [];
    } else if (activePeriod === 'week') {
      rows = data.byWeek || [];
    } else if (activePeriod === 'session') {
      rows = data.bySession || [];
    }

    if (!rows.length) {
      container.innerHTML = '<p class="muted-text">No trade data available for this period.</p>';
      return;
    }

    // Sort by key descending (most recent first) for day/week
    if (activePeriod !== 'session') {
      rows = [...rows].sort((a, b) => (b.key || '').localeCompare(a.key || ''));
    }

    const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '--';
    const fmtPct = (v) => v != null ? (Number(v) * 100).toFixed(1) + '%' : '--';

    let html = `<table class="period-table">
      <thead><tr>
        <th>Period</th><th>Trades</th><th>Wins</th><th>Losses</th>
        <th>Win Rate</th><th>PnL</th><th>Avg PnL</th>
      </tr></thead><tbody>`;

    for (const row of rows) {
      const pnlClass = (row.pnl || 0) >= 0 ? 'positive' : 'negative';
      html += `<tr>
        <td>${row.key || '--'}</td>
        <td>${row.count || 0}</td>
        <td>${row.wins || 0}</td>
        <td>${row.losses || 0}</td>
        <td>${fmtPct(row.winRate)}</td>
        <td class="${pnlClass}">$${fmt(row.pnl)}</td>
        <td>$${fmt(row.avgPnl)}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderAdvancedMetrics(data) {
    const m = data.advancedMetrics || {};
    const el = (id) => document.getElementById(id);

    const sharpe = el('metric-sharpe');
    const sortino = el('metric-sortino');
    const ddUsd = el('metric-dd-usd');
    const ddPct = el('metric-dd-pct');
    const confidence = el('metric-confidence');

    if (sharpe) sharpe.textContent = m.sharpeRatio != null ? Number(m.sharpeRatio).toFixed(2) : '--';
    if (sortino) sortino.textContent = m.sortinoRatio != null ? Number(m.sortinoRatio).toFixed(2) : '--';
    if (ddUsd) ddUsd.textContent = m.maxDrawdownUsd != null ? '$' + Number(m.maxDrawdownUsd).toFixed(2) : '--';
    if (ddPct) ddPct.textContent = m.maxDrawdownPct != null ? (Number(m.maxDrawdownPct) * 100).toFixed(2) + '%' : '--';

    if (confidence) {
      const isHigh = m.metricsConfidence === 'HIGH';
      confidence.textContent = isHigh ? 'HIGH' : 'LOW';
      confidence.classList.toggle('badge-high', isHigh);
      confidence.classList.toggle('badge-low', !isHigh);
    }
  }

  function renderDrawdownChart(data) {
    const canvas = document.getElementById('chart-drawdown');
    if (!canvas || !window.Chart) return;

    const series = data.advancedMetrics?.drawdownSeries || [];

    if (drawdownChart) {
      drawdownChart.destroy();
      drawdownChart = null;
    }

    const labels = series.map(s => s.tradeIndex);
    const ddData = series.map(s => (s.drawdownPct || 0) * 100);  // as percentage, negative values

    drawdownChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Drawdown %',
          data: ddData,
          borderColor: '#f85149',
          backgroundColor: 'rgba(248, 81, 73, 0.15)',
          fill: true,
          tension: 0.2,
          pointRadius: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#e7eefc', boxWidth: 10 } },
          tooltip: { enabled: true },
        },
        scales: {
          x: {
            title: { display: true, text: 'Trade #', color: '#8b949e' },
            ticks: { color: 'rgba(230,237,243,0.4)' },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
          y: {
            title: { display: true, text: 'Drawdown %', color: '#8b949e' },
            ticks: { color: 'rgba(230,237,243,0.4)' },
            grid: { color: 'rgba(255,255,255,0.06)' },
          }
        }
      }
    });
  }

  // ── Optimizer Tab ───────────────────────────────────────────────

  const DEFAULT_PARAM_RANGES = {
    minProbMid: { min: 0.50, max: 0.58, step: 0.01 },
    edgeMid: { min: 0.01, max: 0.06, step: 0.01 },
    noTradeRsiMin: { min: 25, max: 40, step: 5 },
    noTradeRsiMax: { min: 40, max: 55, step: 5 },
    maxEntryPolyPrice: { min: 0.004, max: 0.008, step: 0.001 },
  };

  const PARAM_LABELS = {
    minProbMid: 'Min Prob (Mid)',
    edgeMid: 'Edge (Mid)',
    noTradeRsiMin: 'No-Trade RSI Min',
    noTradeRsiMax: 'No-Trade RSI Max',
    maxEntryPolyPrice: 'Max Entry Poly Price',
  };

  let optimizerResults = null;
  let sortColumn = 'profitFactor';
  let sortDirection = 'desc';

  function initOptimizerForm() {
    const formEl = document.getElementById('optimizer-form');
    if (!formEl) return;

    let html = '<div class="param-ranges-grid">';
    for (const [param, range] of Object.entries(DEFAULT_PARAM_RANGES)) {
      const label = PARAM_LABELS[param] || param;
      html += `
        <div class="param-range-group">
          <label class="param-label">${label}</label>
          <div class="param-inputs">
            <label><span>Min</span><input type="number" id="opt-${param}-min" value="${range.min}" step="${range.step}"></label>
            <label><span>Max</span><input type="number" id="opt-${param}-max" value="${range.max}" step="${range.step}"></label>
            <label><span>Step</span><input type="number" id="opt-${param}-step" value="${range.step}" step="${range.step}"></label>
          </div>
        </div>`;
    }
    html += '</div>';
    formEl.innerHTML = html;
  }

  function readFormRanges() {
    const ranges = {};
    for (const param of Object.keys(DEFAULT_PARAM_RANGES)) {
      const min = parseFloat(document.getElementById(`opt-${param}-min`)?.value);
      const max = parseFloat(document.getElementById(`opt-${param}-max`)?.value);
      const step = parseFloat(document.getElementById(`opt-${param}-step`)?.value);
      if (!isNaN(min) && !isNaN(max) && !isNaN(step) && step > 0 && min <= max) {
        ranges[param] = { min, max, step };
      }
    }
    return ranges;
  }

  async function runOptimizer() {
    const statusEl = document.getElementById('optimizer-status');
    const resultsEl = document.getElementById('optimizer-results');
    const runBtn = document.getElementById('run-optimizer');

    if (statusEl) statusEl.textContent = 'Running optimizer...';
    if (runBtn) runBtn.disabled = true;
    if (resultsEl) resultsEl.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const paramRanges = readFormRanges();
      const res = await fetch('/api/optimizer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paramRanges }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Optimizer failed');
      }

      optimizerResults = json.data;

      if (statusEl) {
        statusEl.textContent = `Tested ${optimizerResults.totalCombinations} combinations, skipped ${optimizerResults.skippedCombinations} (< 30 trades)`;
      }

      renderOptimizerResults();
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err.message}`;
      if (resultsEl) resultsEl.innerHTML = `<p class="muted-text">Optimizer failed: ${err.message}</p>`;
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  function renderOptimizerResults() {
    const container = document.getElementById('optimizer-results');
    if (!container || !optimizerResults) return;

    const results = optimizerResults.results || [];
    const paramNames = optimizerResults.paramNames || [];

    if (!results.length) {
      container.innerHTML = '<p class="muted-text">No results with enough trades. Need more paper trading history or broaden parameter ranges.</p>';
      return;
    }

    // Sort results
    const sorted = [...results].sort((a, b) => {
      let va = a[sortColumn];
      let vb = b[sortColumn];
      // For params, use first param value as tiebreaker
      if (sortColumn.startsWith('param:')) {
        const pName = sortColumn.slice(6);
        va = a.params?.[pName] ?? 0;
        vb = b.params?.[pName] ?? 0;
      }
      if (va == null) va = -Infinity;
      if (vb == null) vb = -Infinity;
      return sortDirection === 'desc' ? vb - va : va - vb;
    });

    const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '--';
    const fmtPct = (v) => v != null ? (Number(v) * 100).toFixed(1) + '%' : '--';

    // Build columns
    const metricCols = [
      { key: 'tradeCount', label: 'Trades' },
      { key: 'winRate', label: 'Win Rate' },
      { key: 'profitFactor', label: 'PF' },
      { key: 'totalPnl', label: 'Total PnL' },
      { key: 'expectancy', label: 'Expect.' },
    ];

    // Header
    let html = '<table class="optimizer-results-table"><thead><tr>';
    html += '<th>#</th>';
    for (const pName of paramNames) {
      const label = PARAM_LABELS[pName] || pName;
      const sortKey = `param:${pName}`;
      const arrow = sortColumn === sortKey ? (sortDirection === 'desc' ? ' v' : ' ^') : '';
      html += `<th class="sortable" data-sort="${sortKey}">${label}${arrow}</th>`;
    }
    for (const col of metricCols) {
      const arrow = sortColumn === col.key ? (sortDirection === 'desc' ? ' v' : ' ^') : '';
      html += `<th class="sortable" data-sort="${col.key}">${col.label}${arrow}</th>`;
    }
    html += '<th>Apply</th></tr></thead><tbody>';

    // Rows
    sorted.forEach((row, idx) => {
      const isBest = idx === 0;
      const rowClass = isBest ? 'best-combo' : '';
      html += `<tr class="${rowClass}">`;
      html += `<td>${idx + 1}</td>`;

      for (const pName of paramNames) {
        html += `<td>${fmt(row.params?.[pName], 4)}</td>`;
      }

      html += `<td>${row.tradeCount || 0}</td>`;
      html += `<td>${fmtPct(row.winRate)}</td>`;
      html += `<td>${fmt(row.profitFactor)}</td>`;
      html += `<td class="${(row.totalPnl || 0) >= 0 ? 'positive' : 'negative'}">$${fmt(row.totalPnl)}</td>`;
      html += `<td>$${fmt(row.expectancy)}</td>`;
      html += `<td><button class="apply-btn" data-idx="${idx}">Apply</button></td>`;
      html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    // Attach sort handlers
    container.querySelectorAll('.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortColumn === key) {
          sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
        } else {
          sortColumn = key;
          sortDirection = 'desc';
        }
        renderOptimizerResults();
      });
    });

    // Attach apply handlers
    container.querySelectorAll('.apply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const sortedResults = [...results].sort((a, b) => {
          let va = a[sortColumn];
          let vb = b[sortColumn];
          if (sortColumn.startsWith('param:')) {
            const pName = sortColumn.slice(6);
            va = a.params?.[pName] ?? 0;
            vb = b.params?.[pName] ?? 0;
          }
          if (va == null) va = -Infinity;
          if (vb == null) vb = -Infinity;
          return sortDirection === 'desc' ? vb - va : va - vb;
        });
        const selectedResult = sortedResults[idx];
        if (selectedResult?.params) {
          applyConfig(selectedResult.params);
        }
      });
    });
  }

  async function applyConfig(params) {
    const statusEl = document.getElementById('optimizer-status');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Apply failed');

      const data = json.data;
      let msg = 'Config applied successfully!';
      if (data.warning) msg += ' WARNING: ' + data.warning;

      if (statusEl) {
        statusEl.textContent = msg;
        statusEl.classList.add('apply-success');
        setTimeout(() => statusEl.classList.remove('apply-success'), 3000);
      }

      // Show revert button
      showRevertButton(true);
      fetchCurrentConfig();
    } catch (err) {
      if (statusEl) statusEl.textContent = `Apply failed: ${err.message}`;
    }
  }

  async function revertConfig() {
    const statusEl = document.getElementById('optimizer-status');
    try {
      const res = await fetch('/api/config/revert', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Revert failed');

      if (statusEl) statusEl.textContent = 'Config reverted to previous values.';
      showRevertButton(false);
      fetchCurrentConfig();
    } catch (err) {
      if (statusEl) statusEl.textContent = `Revert failed: ${err.message}`;
    }
  }

  function showRevertButton(show) {
    const btn = document.getElementById('revert-config');
    if (btn) btn.style.display = show ? 'inline-block' : 'none';
  }

  async function checkRevertAvailable() {
    try {
      const res = await fetch('/api/config/current');
      const json = await res.json();
      if (json.success && json.data?.revertAvailable) {
        showRevertButton(true);
      }
    } catch { /* ignore */ }
  }

  async function fetchCurrentConfig() {
    const container = document.getElementById('current-config-display');
    if (!container) return;

    try {
      const res = await fetch('/api/config/current');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Config fetch failed');

      const config = json.data?.currentConfig || {};
      const entries = Object.entries(config);

      if (!entries.length) {
        container.innerHTML = '<p class="muted-text">Engine not initialized. Start the server to see current config.</p>';
        return;
      }

      let html = '<table class="config-table"><tbody>';
      for (const [key, value] of entries) {
        const label = PARAM_LABELS[key] || key;
        html += `<tr><td class="k">${label}</td><td class="v">${value != null ? value : '--'}</td></tr>`;
      }
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="muted-text">${err.message}</p>`;
    }
  }

  // ── Event Bindings ──────────────────────────────────────────────

  const runBtn = document.getElementById('run-optimizer');
  if (runBtn) runBtn.addEventListener('click', runOptimizer);

  const revertBtn = document.getElementById('revert-config');
  if (revertBtn) revertBtn.addEventListener('click', revertConfig);

  // Initialize optimizer form with default ranges
  initOptimizerForm();
});
