/* global Chart */

document.addEventListener('DOMContentLoaded', () => {
  const statusMessage = document.getElementById('status-message');
  const openTradeDiv = document.getElementById('open-trade');
  const ledgerSummaryDiv = document.getElementById('ledger-summary');

  // KPI elements
  const kpiBalance = document.getElementById('kpi-balance');
  const kpiRealized = document.getElementById('kpi-realized');
  const kpiPnlToday = document.getElementById('kpi-pnl-today');
  const kpiTradesToday = document.getElementById('kpi-trades-today');
  const kpiPnlYesterday = document.getElementById('kpi-pnl-yesterday');
  const kpiTradesYesterday = document.getElementById('kpi-trades-yesterday');
  const kpiWinrate = document.getElementById('kpi-winrate');
  const kpiProfitFactor = document.getElementById('kpi-profit-factor');

  // Phase 3: Kill-switch elements
  const ksPnlLabel = document.getElementById('ks-pnl-label');
  const ksProgressBar = document.getElementById('ks-progress-bar');
  const ksBanner = document.getElementById('ks-banner');
  const ksOverrideSection = document.getElementById('ks-override-section');
  const ksOverrideBtn = document.getElementById('ks-override-btn');
  const ksOverrideInfo = document.getElementById('ks-override-info');
  const ksSyncIndicator = document.getElementById('ks-sync-indicator');

  // Phase 3: Order lifecycle elements
  const orderLifecycleCard = document.getElementById('order-lifecycle-card');
  const orderLifecyclePanel = document.getElementById('order-lifecycle-panel');

  // ── Trading controls ──────────────────────────────────────────
  const startBtn = document.getElementById('start-trading');
  const stopBtn = document.getElementById('stop-trading');
  const tradingStatusEl = document.getElementById('trading-status');
  const modeSelect = document.getElementById('mode-select');

  function updateTradingStatus(enabled) {
    if (tradingStatusEl) {
      tradingStatusEl.textContent = enabled ? 'ACTIVE' : 'STOPPED';
      tradingStatusEl.classList.toggle('status--active', enabled);
      tradingStatusEl.classList.toggle('status--stopped', !enabled);
    }
    if (startBtn) startBtn.disabled = enabled;
    if (stopBtn) stopBtn.disabled = !enabled;
  }

  // ── Instance locking ───────────────────────────────────────
  // On the first successful poll we record the server's _instanceId.
  // Subsequent responses from a DIFFERENT instance are silently dropped
  // so that multiple server processes / crash-restarts can never cause
  // oscillation in ANY field (mode, tradingEnabled, entryDebug, etc.).
  // If we see 5 consecutive responses from a new instance, we switch
  // to it (the original has likely died).
  let _lockedInstanceId = null;
  let _foreignInstanceCount = 0;
  const _INSTANCE_SWITCH_THRESHOLD = 5;
  let _seekingInstance = false;
  let _seekingPollCount = 0;
  const _SEEKING_TIMEOUT_POLLS = 20; // ~30s at 1.5s interval

  // After a user action POST (Start/Stop/Mode), reset the instance lock
  // and enter seeking mode — poll without locking until we find an instance
  // whose tradingEnabled matches our local UI state, then lock to it.
  function _resetInstanceLock() {
    _lockedInstanceId = null;
    _foreignInstanceCount = 0;
    _seekingInstance = true;
    _seekingPollCount = 0;
  }

  // Mode and tradingEnabled are ONLY synced from the server on the very
  // first poll after page load.  After that, these values are exclusively
  // controlled by user actions (buttons / dropdown).
  let _initialSyncDone = false;

  startBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/trading/start', { method: 'POST' });
      const json = await res.json();
      if (json.success) { updateTradingStatus(true); _resetInstanceLock(); }
    } catch (e) { console.error('Start trading failed:', e); }
  });

  stopBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/trading/stop', { method: 'POST' });
      const json = await res.json();
      if (json.success) { updateTradingStatus(false); _resetInstanceLock(); }
    } catch (e) { console.error('Stop trading failed:', e); }
  });

  modeSelect?.addEventListener('change', async () => {
    const desiredMode = modeSelect.value;
    try {
      const res = await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: desiredMode }),
      });
      const json = await res.json();
      if (json.success) {
        updateTradingStatus(json.data.tradingEnabled);
        _resetInstanceLock();
      } else {
        // Revert dropdown on failure
        const statusRes = await fetch('/api/trading/status');
        const statusJson = await statusRes.json();
        if (statusJson.success && modeSelect) {
          modeSelect.value = statusJson.data.mode || 'paper';
        }
        alert(json.error || 'Mode switch failed');
      }
    } catch (e) {
      console.error('Mode switch failed:', e);
    }
  });

  // Phase 3: Kill-switch override handler
  ksOverrideBtn?.addEventListener('click', async () => {
    if (!confirm('Override the kill-switch? Trading will resume with a reduced loss budget (10% buffer). This cannot be undone until the next daily reset.')) return;
    try {
      const res = await fetch('/api/kill-switch/override', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        if (ksOverrideInfo) ksOverrideInfo.textContent = `Override #${json.data?.overrideCount ?? '?'} applied`;
      } else {
        alert(json.error || 'Override failed');
      }
    } catch (e) { console.error('Kill-switch override failed:', e); }
  });

  // top right pill (removed — replaced by trading controls)

  // Phase 5: Status bar elements
  const sbModeValue = document.getElementById('sb-mode-value');
  const sbTradingValue = document.getElementById('sb-trading-value');
  const sbKsValue = document.getElementById('sb-ks-value');
  const sbSqliteValue = document.getElementById('sb-sqlite-value');
  const sbWebhooksValue = document.getElementById('sb-webhooks-value');
  const sbUptimeValue = document.getElementById('sb-uptime-value');
  const sqliteFallbackBanner = document.getElementById('sqlite-fallback-banner');

  // Phase 5: Fetch metrics for status bar (one-shot + periodic)
  let _metricsCache = null;
  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/metrics');
      const json = await res.json();
      if (json.success) _metricsCache = json.data;
    } catch { /* best-effort */ }
  };

  const updateStatusBar = () => {
    const m = _metricsCache;
    const localMode = (modeSelect?.value || 'paper').toUpperCase();
    const localTrading = tradingStatusEl?.textContent === 'ACTIVE';

    // Mode
    if (sbModeValue) {
      sbModeValue.textContent = localMode;
      sbModeValue.className = 'sb-value ' + (localMode === 'LIVE' ? 'sb-warn' : 'sb-ok');
    }

    // Trading
    if (sbTradingValue) {
      sbTradingValue.textContent = localTrading ? 'Active' : 'Stopped';
      sbTradingValue.className = 'sb-value ' + (localTrading ? 'sb-ok' : 'sb-danger');
    }

    // Kill-switch
    if (sbKsValue && m) {
      const ksTripped = m.state?.circuitBreakerTripped;
      if (ksTripped) {
        sbKsValue.textContent = 'Tripped';
        sbKsValue.className = 'sb-value sb-danger';
      } else {
        sbKsValue.textContent = 'OK';
        sbKsValue.className = 'sb-value sb-ok';
      }
    }

    // Supabase
    if (sbSqliteValue && m) {
      const sqliteOk = m.persistence?.supabase;
      sbSqliteValue.textContent = sqliteOk ? 'Connected' : 'Fallback (JSON)';
      sbSqliteValue.className = 'sb-value ' + (sqliteOk ? 'sb-ok' : 'sb-degraded');

      // Show/hide fallback banner
      if (sqliteFallbackBanner) {
        sqliteFallbackBanner.classList.toggle('hidden', sqliteOk !== false);
      }
    }

    // Webhooks
    if (sbWebhooksValue && m) {
      // Webhooks info not in /api/metrics directly; check if services exist
      const hasServices = m.services !== null;
      sbWebhooksValue.textContent = hasServices ? 'Configured' : 'Not configured';
      sbWebhooksValue.className = 'sb-value ' + (hasServices ? 'sb-ok' : 'sb-not-configured');
    }

    // Uptime
    if (sbUptimeValue && m) {
      const secs = m.uptime ?? 0;
      if (secs < 60) {
        sbUptimeValue.textContent = `${Math.round(secs)}s`;
      } else if (secs < 3600) {
        sbUptimeValue.textContent = `${Math.floor(secs / 60)}m`;
      } else {
        sbUptimeValue.textContent = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
      }
    }
  };

  // Fetch metrics on load and every 10s
  fetchMetrics().then(updateStatusBar);
  setInterval(() => fetchMetrics().then(updateStatusBar), 10_000);

  const recentTradesBody = document.getElementById('recent-trades-body');

  // Trade filters
  const tradesLimitSel = document.getElementById('trades-limit');
  const tradesReasonSel = document.getElementById('trades-reason');
  const tradesSideSel = document.getElementById('trades-side');
  const tradesOnlyLosses = document.getElementById('trades-only-losses');

  // Formatting
  const formatCurrency = (value, decimals = 2) => Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const formatPercentage = (value, decimals = 2) => Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';

  const formatCents = (dollars) => {
    if (dollars == null || !Number.isFinite(Number(dollars))) return 'N/A';
    const cents = Number(dollars) * 100;
    const decimals = cents < 1 ? 4 : 2;
    return cents.toFixed(decimals);
  };

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
  const dayKey = (iso) => {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  };

  const todayKey = () => dayKey(new Date().toISOString());
  const yesterdayKey = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  };

  // Charts
  let chartEquity = null;

  const chartColors = {
    good: '#3fb950',
    bad: '#f85149',
    accent: '#58a6ff',
    muted: 'rgba(230,237,243,0.4)',
    grid: 'rgba(255,255,255,0.06)'
  };

  const ensureCharts = () => {
    if (!window.Chart) return;

    // Register "No data yet" plugin (once)
    if (!Chart.registry?.plugins?.get?.('noDataMessage')) {
      const noDataPlugin = {
        id: 'noDataMessage',
        afterDraw(chart) {
          const hasData = chart.data.datasets.some(ds => ds.data && ds.data.length > 0);
          if (!hasData) {
            const { ctx, width, height } = chart;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '14px ' + getComputedStyle(document.body).fontFamily;
            ctx.fillStyle = 'rgba(155,176,209,0.5)';
            ctx.fillText('No data yet', width / 2, height / 2);
            ctx.restore();
          }
        }
      };
      Chart.register(noDataPlugin);
    }

    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e7eefc', boxWidth: 10 } },
        tooltip: { enabled: true }
      },
      scales: {
        x: { ticks: { color: chartColors.muted }, grid: { color: chartColors.grid } },
        y: { ticks: { color: chartColors.muted }, grid: { color: chartColors.grid } }
      }
    };

    const equityEl = document.getElementById('chart-equity');
    if (equityEl && !chartEquity) {
      chartEquity = new Chart(equityEl, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Equity', data: [], borderColor: chartColors.accent, backgroundColor: 'rgba(110,168,255,0.15)', tension: 0.25, fill: true, pointRadius: 0 }] },
        options: { ...baseOpts }
      });
    }

  };

  const updateEquityCurve = (trades, startingBalance) => {
    if (!chartEquity) return;
    const closed = (Array.isArray(trades) ? trades : []).filter(t => t.status === 'CLOSED');
    const sorted = [...closed].sort((a, b) => new Date(a.exitTime || a.timestamp) - new Date(b.exitTime || b.timestamp));
    let eq = Number(startingBalance) || 0;
    const labels = [];
    const data = [];
    for (const t of sorted) {
      const pnl = Number(t.pnl) || 0;
      eq += pnl;
      const ts = t.exitTime || t.timestamp || t.entryTime;
      labels.push(ts ? new Date(ts).toLocaleTimeString() : '');
      data.push(Number(eq.toFixed(2)));
    }
    // Downsample if huge
    const maxPts = 250;
    let dsLabels = labels;
    let dsData = data;
    if (data.length > maxPts) {
      const step = Math.ceil(data.length / maxPts);
      dsLabels = labels.filter((_, i) => i % step === 0);
      dsData = data.filter((_, i) => i % step === 0);
    }

    chartEquity.data.labels = dsLabels;
    chartEquity.data.datasets[0].data = dsData;
    chartEquity.update('none');
  };

  const setKpi = (el, text, cls = null) => {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
  };

  let lastTradesCache = [];
  let lastStatusCache = null;

  const renderTradesTable = () => {
    const trades = Array.isArray(lastTradesCache) ? lastTradesCache : [];
    const limit = Number(tradesLimitSel?.value || 50);
    const reason = tradesReasonSel?.value || '';
    const side = tradesSideSel?.value || '';
    const onlyLosses = Boolean(tradesOnlyLosses?.checked);

    const filtered = trades
      .slice() // copy
      .reverse() // newest first
      .filter(t => t && t.status === 'CLOSED')
      .filter(t => !reason || String(t.exitReason || '') === reason)
      .filter(t => !side || String(t.side || '') === side)
      .filter(t => !onlyLosses || (Number(t.pnl) || 0) < 0)
      .slice(0, limit);

    if (!filtered.length) {
      recentTradesBody.innerHTML = '<tr><td colspan="8">No trades match filters.</td></tr>';
      return;
    }

    const rowsHtml = filtered.map((trade) => {
      const entryPx = (trade.entryPrice != null) ? formatCents(trade.entryPrice) : 'N/A';
      const exitPx = (trade.exitPrice != null) ? formatCents(trade.exitPrice) : 'N/A';
      const entryAt = trade.entryTime ? new Date(trade.entryTime).toLocaleString() : 'N/A';
      const exitAt = trade.exitTime ? new Date(trade.exitTime).toLocaleString() : 'N/A';
      const pnl = (trade.pnl != null) ? Number(trade.pnl) : 0;
      const pnlClass = pnl >= 0 ? 'positive' : 'negative';

      return `
        <tr>
          <td>${entryAt}</td>
          <td>${exitAt}</td>
          <td>${trade.side || 'N/A'}</td>
          <td>${entryPx}</td>
          <td>${exitPx}</td>
          <td class="${pnlClass}">${formatCurrency(pnl)}</td>
          <td>${trade.status || 'N/A'}</td>
          <td>${trade.exitReason || 'N/A'}</td>
        </tr>
      `;
    }).join('');

    recentTradesBody.innerHTML = rowsHtml;
  };

  const refreshReasonFilter = (trades) => {
    if (!tradesReasonSel) return;
    const existing = new Set([...tradesReasonSel.options].map(o => o.value));
    const reasons = Array.from(new Set((trades || []).map(t => t.exitReason).filter(Boolean))).sort();
    for (const r of reasons) {
      if (!existing.has(r)) {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        tradesReasonSel.appendChild(opt);
      }
    }
  };

  // Main fetch loop
  let _fetchInProgress = false;
  const fetchData = async () => {
    // Prevent overlapping polls — if a previous fetch is still pending
    // (e.g. CLOB timeout), skip this cycle to avoid racing UI updates.
    if (_fetchInProgress) return;
    _fetchInProgress = true;
    try { await _fetchDataInner(); } finally { _fetchInProgress = false; }
  };

  const _fetchDataInner = async () => {
    // Tab-aware polling: only fetch dashboard data when dashboard tab is active.
    // Analytics/optimizer tabs handle their own data fetching on demand (RESEARCH.md Pitfall 7).
    // Exception: first poll always runs (syncs mode/trading state per first-poll-only pattern).
    const activeTab = window.__activeTab || 'dashboard';
    if (activeTab !== 'dashboard' && _initialSyncDone) return;

    ensureCharts();

    // ---- status ----
    try {
      const statusResponse = await fetch('/api/status');
      const statusJson = await statusResponse.json();
      if (!statusResponse.ok || !statusJson.success) throw new Error(statusJson.error || 'status endpoint failed');
      const statusData = statusJson.data;

      // ── Instance locking ────────────────────────────────────
      // Drop responses from a different server instance to prevent
      // ALL oscillation (not just mode — also entryDebug, balances, etc.)
      // After a user action POST, we enter "seeking mode" — poll without
      // locking until we find an instance whose tradingEnabled matches
      // our local UI state, then lock to that instance.
      // Instance locking: skip STATUS rendering from wrong instances.
      // Trades section always runs (trades read from persistent SQLite).
      const respInstanceId = statusData?.status?._instanceId;
      let _skipStatusRender = false;
      if (_seekingInstance) {
        _seekingPollCount++;
        const localEnabled = tradingStatusEl?.textContent === 'ACTIVE';
        const serverEnabled = statusData.tradingEnabled ?? false;
        const localMode = (modeSelect?.value || 'paper').toUpperCase();
        const serverMode = (statusData.mode || 'PAPER').toUpperCase();
        if (localEnabled === serverEnabled && localMode === serverMode) {
          _lockedInstanceId = respInstanceId;
          _foreignInstanceCount = 0;
          _seekingInstance = false;
        } else if (_seekingPollCount >= _SEEKING_TIMEOUT_POLLS) {
          console.warn(`[UI] Seeking mode timed out after ${_seekingPollCount} polls, accepting instance ${respInstanceId}`);
          _lockedInstanceId = respInstanceId;
          _foreignInstanceCount = 0;
          _seekingInstance = false;
        } else {
          _skipStatusRender = true; // wrong instance — skip status, but still fetch trades
        }
      } else if (_lockedInstanceId === null) {
        if (_initialSyncDone) {
          const localEnabled = tradingStatusEl?.textContent === 'ACTIVE';
          const serverEnabled = statusData.tradingEnabled ?? false;
          const localMode = (modeSelect?.value || 'paper').toUpperCase();
          const serverMode = (statusData.mode || 'PAPER').toUpperCase();
          if (localEnabled !== serverEnabled || localMode !== serverMode) {
            _skipStatusRender = true; // wrong instance — skip status, but still fetch trades
          }
        }
        if (!_skipStatusRender) {
          _lockedInstanceId = respInstanceId;
          _foreignInstanceCount = 0;
        }
      } else if (respInstanceId && respInstanceId !== _lockedInstanceId) {
        _foreignInstanceCount++;
        if (_foreignInstanceCount >= _INSTANCE_SWITCH_THRESHOLD) {
          console.warn(`[UI] Lost instance ${_lockedInstanceId}, entering seeking mode`);
          _lockedInstanceId = null;
          _foreignInstanceCount = 0;
          _seekingInstance = true;
        }
        _skipStatusRender = true; // foreign instance — skip status, but still fetch trades
      } else {
        _foreignInstanceCount = 0;
      }

      // If wrong instance, skip STATUS rendering but still fetch trades.
      // Trades are read from persistent Supabase, so they're consistent
      // regardless of which server instance serves the request.
      if (_skipStatusRender) throw new Error('__skip_status__');

      lastStatusCache = statusData;

      // Update status bar with kill-switch data from status response
      const ksData = statusData.killSwitch;
      if (sbKsValue && ksData) {
        if (ksData.active && !ksData.overrideActive) {
          sbKsValue.textContent = 'ACTIVE';
          sbKsValue.className = 'sb-value sb-danger';
        } else if (ksData.overrideActive) {
          sbKsValue.textContent = 'Overridden';
          sbKsValue.className = 'sb-value sb-warn';
        } else {
          sbKsValue.textContent = 'OK';
          sbKsValue.className = 'sb-value sb-ok';
        }
      }

      // ── First-poll-only sync ────────────────────────────────
      // Sync mode + tradingEnabled from the server ONCE on page load.
      // After that, these are only changed by user actions (buttons /
      // dropdown).  The polling loop never overwrites them again.
      if (!_initialSyncDone) {
        updateTradingStatus(statusData.tradingEnabled ?? false);
        if (modeSelect) {
          const serverMode = (statusData.mode || 'PAPER').toLowerCase();
          if (modeSelect.value !== serverMode) {
            modeSelect.value = serverMode;
          }
        }
        _initialSyncDone = true;
      }

      const rt = statusData.runtime;
      // Use the DROPDOWN's value as the authoritative mode — never the
      // server response — so that all components stay consistent with
      // the first-poll-only sync and user-driven mode switches.
      const mode = (modeSelect?.value || 'paper').toUpperCase();
      if (!statusData?.status?.ok) {
        statusMessage.textContent = 'Not OK';
      } else if (!rt) {
        statusMessage.textContent = `OK (updated ${new Date(statusData.status.updatedAt).toLocaleTimeString()})`;
      } else {
        const up = (rt.modelUp != null) ? Math.round(rt.modelUp * 100) + '%' : 'N/A';
        const down = (rt.modelDown != null) ? Math.round(rt.modelDown * 100) + '%' : 'N/A';
        const btc = (rt.btcPrice != null) ? '$' + Number(rt.btcPrice).toFixed(2) : 'N/A';
        const polyUp = (rt.polyUp != null) ? (Number(rt.polyUp) * 100).toFixed(2) + '¢' : 'N/A';
        const polyDown = (rt.polyDown != null) ? (Number(rt.polyDown) * 100).toFixed(2) + '¢' : 'N/A';
        const pmUrl = rt.marketSlug ? `https://polymarket.com/market/${rt.marketSlug}` : null;
        const cc = (rt.candleCount != null) ? rt.candleCount : 0;

        const timeLeft = (rt.timeLeftMin != null)
          ? `${Math.floor(Math.max(0, rt.timeLeftMin))}m ${Math.floor((Math.max(0, rt.timeLeftMin) % 1) * 60)}s`
          : 'N/A';

        const entryDbg = statusData.entryDebug || null;
        const hasOpenTrade = Boolean(statusData.openTrade);
        const locallyActive = tradingStatusEl?.textContent === 'ACTIVE';

        // Quick summary line
        let entrySummary;
        if (!entryDbg) {
          entrySummary = 'N/A';
        } else if (hasOpenTrade) {
          entrySummary = '<span style="color:var(--warn)">Monitoring open position</span>';
        } else if (entryDbg.eligible) {
          entrySummary = '<span style="color:var(--good)">ELIGIBLE</span>';
        } else {
          let blockers = entryDbg.blockers || [];
          if (locallyActive) blockers = blockers.filter(b => !/trading disabled/i.test(b));
          if (hasOpenTrade) blockers = blockers.filter(b => !/trade already open|position open/i.test(b));
          const failCount = blockers.length;
          entrySummary = failCount
            ? `<span style="color:var(--bad)">${failCount} blocker${failCount > 1 ? 's' : ''}</span> <span style="opacity:0.6;font-size:12px">— ${blockers.join('; ')}</span>`
            : '<span style="color:var(--good)">ELIGIBLE</span>';
        }

        const rows = [
          ['Mode', `<strong>${mode}</strong> ${tradingStatusEl?.textContent === 'ACTIVE' ? '<span style="color:var(--good)">ACTIVE</span>' : '<span style="color:var(--bad)">STOPPED</span>'}`],
          ['Market', `${rt.marketSlug || 'N/A'} ${pmUrl ? `<a href="${pmUrl}" target="_blank" style="opacity:0.5;font-size:11px">[link]</a>` : ''}`],
          ['Time left', timeLeft],
          ['BTC', btc],
          ['Poly UP / DOWN', `${polyUp} / ${polyDown}`],
          ['Model', `${rt.narrative || 'N/A'} (UP ${up} / DOWN ${down})`],
          ['Candles (1m)', String(cc)],
          ['Price Feed', (() => {
            const lastTick = rt.lastTickAt ? new Date(rt.lastTickAt) : null;
            const ticks = rt.tickCount ?? 0;
            if (!lastTick) return `<span style="color:var(--bad)">No ticks yet</span> (${ticks} total)`;
            const agoSec = Math.round((Date.now() - lastTick.getTime()) / 1000);
            const agoLabel = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
            const color = agoSec < 180 ? 'var(--good)' : 'var(--bad)';
            return `<span style="color:${color}">Last tick ${agoLabel}</span> (${ticks.toLocaleString()} total)`;
          })()],
          ['Entry Gate', entrySummary],
        ];

        // ── Live Gate Status: current values vs thresholds ──────────────
        const thr = statusData.entryThresholds;
        if (thr && rt) {
          // Helpers
          const pass = ok => ok ? '<span style="color:var(--good)">✅</span>' : '<span style="color:var(--bad)">❌</span>';
          const na = '<span style="opacity:0.4">N/A</span>';
          const pct  = v => v != null ? `${(v * 100).toFixed(1)}%` : null;
          const pctS = v => v != null ? `${(v * 100).toFixed(1)}%` : '—';
          const c    = v => v != null ? `${(v * 100).toFixed(2)}c` : '—';

          // Determine effective thresholds (apply weekend tightening if active)
          const wknd = thr.weekendTighteningActive;

          // Which phase are we in?
          const phase = rt.recPhase || 'MID';
          const effMinProb = phase === 'EARLY' ? thr.minProbEarly
            : phase === 'LATE' ? thr.minProbLate : thr.minProbMid;
          const effMinProbW = wknd ? effMinProb + (thr.weekendProbBoost ?? 0) : effMinProb;
          const effEdge = phase === 'EARLY' ? thr.edgeEarly
            : phase === 'LATE' ? thr.edgeLate : thr.edgeMid;
          const effEdgeW = wknd ? effEdge + (thr.weekendEdgeBoost ?? 0) : effEdge;
          const effMaxSpread = wknd ? (thr.weekendMaxSpread ?? thr.maxSpread) : thr.maxSpread;
          const effMinLiq = wknd ? (thr.weekendMinLiquidity ?? thr.minLiquidity) : thr.minLiquidity;
          const effMinModelMax = wknd ? (thr.weekendMinModelMaxProb ?? thr.minModelMaxProb) : thr.minModelMaxProb;
          const effMinRange = wknd ? (thr.weekendMinRangePct20 ?? thr.minRangePct20) : thr.minRangePct20;

          // Current values
          const modelProb = (rt.narrative === 'LONG' || (rt.recSide === 'UP'))
            ? rt.modelUp : rt.modelDown;
          const modelMax = (rt.modelUp != null && rt.modelDown != null)
            ? Math.max(rt.modelUp, rt.modelDown) : null;
          const edge = rt.recEdge;
          const rsi = rt.rsiNow;
          const impulseAbs = rt.spotDelta1mPct != null ? Math.abs(rt.spotDelta1mPct) : null;
          const range = rt.rangePct20;
          const worstSpread = [rt.spreadUp, rt.spreadDown].filter(v => v != null).length
            ? Math.max(...[rt.spreadUp, rt.spreadDown].filter(v => v != null))
            : null;
          const liq = rt.liquidityNum;
          const effectiveSide = rt.recSide || (rt.modelUp != null && rt.modelDown != null ? (rt.modelUp >= rt.modelDown ? 'UP' : 'DOWN') : null);
          const entryPolyPrice = effectiveSide === 'UP' ? rt.polyUp : effectiveSide === 'DOWN' ? rt.polyDown : null;
          const oppPolyPrice = effectiveSide === 'UP' ? rt.polyDown : effectiveSide === 'DOWN' ? rt.polyUp : null;
          const tlm = rt.timeLeftMin;

          // Build gate rows: [label, currentStr, passStr, thresholdStr]
          const gateRows = [];

          // Rec
          const recOk = rt.recAction === 'ENTER';
          gateRows.push(['Rec', `${rt.recAction || '—'} ${rt.recSide || ''} (${phase})`, pass(recOk), 'ENTER']);

          // Probability
          if (modelProb != null) {
            const probOk = modelProb >= effMinProbW;
            gateRows.push(['Prob', pctS(modelProb), pass(probOk), `>= ${pctS(effMinProbW)}`]);
          } else {
            gateRows.push(['Prob', '—', na, `>= ${pctS(effMinProbW)}`]);
          }

          // Edge
          if (edge != null) {
            const edgeOk = edge >= effEdgeW;
            gateRows.push(['Edge', pctS(edge), pass(edgeOk), `>= ${pctS(effEdgeW)}`]);
          } else {
            gateRows.push(['Edge', '—', na, `>= ${pctS(effEdgeW)}`]);
          }

          // RSI
          if (rsi != null) {
            const inBand = rsi >= (thr.noTradeRsiMin ?? 30) && rsi < (thr.noTradeRsiMax ?? 45);
            gateRows.push(['RSI', rsi.toFixed(1), pass(!inBand), `outside ${thr.noTradeRsiMin}-${thr.noTradeRsiMax}`]);
          } else {
            gateRows.push(['RSI', '—', na, `outside ${thr.noTradeRsiMin}-${thr.noTradeRsiMax}`]);
          }

          // Impulse
          if (impulseAbs != null) {
            const impulseOk = impulseAbs >= (thr.minBtcImpulsePct1m ?? 0);
            gateRows.push(['Impulse', `${(impulseAbs * 100).toFixed(3)}%`, pass(impulseOk), `>= ${((thr.minBtcImpulsePct1m ?? 0) * 100).toFixed(3)}%`]);
          } else {
            gateRows.push(['Impulse', '—', na, `>= ${((thr.minBtcImpulsePct1m ?? 0) * 100).toFixed(3)}%`]);
          }

          // Range (volatility)
          if (range != null) {
            const rangeOk = range >= effMinRange;
            gateRows.push(['Range20', `${(range * 100).toFixed(3)}%`, pass(rangeOk), `>= ${(effMinRange * 100).toFixed(3)}%`]);
          } else {
            gateRows.push(['Range20', '—', na, `>= ${(effMinRange * 100).toFixed(3)}%`]);
          }

          // Conviction (model max prob)
          if (modelMax != null) {
            const convOk = modelMax >= effMinModelMax;
            gateRows.push(['Conviction', pctS(modelMax), pass(convOk), `>= ${pctS(effMinModelMax)}`]);
          } else {
            gateRows.push(['Conviction', '—', na, `>= ${pctS(effMinModelMax)}`]);
          }

          // Spread
          if (worstSpread != null) {
            const spreadOk = worstSpread <= effMaxSpread;
            gateRows.push(['Spread', c(worstSpread), pass(spreadOk), `<= ${c(effMaxSpread)}`]);
          } else {
            gateRows.push(['Spread', '—', na, `<= ${c(effMaxSpread)}`]);
          }

          // Liquidity
          if (liq != null) {
            const liqOk = liq >= effMinLiq;
            gateRows.push(['Liquidity', `$${Number(liq).toLocaleString()}`, pass(liqOk), `>= $${Number(effMinLiq).toLocaleString()}`]);
          } else {
            gateRows.push(['Liquidity', '—', na, `>= $${Number(effMinLiq).toLocaleString()}`]);
          }

          // Entry price
          if (entryPolyPrice != null) {
            const epOk = entryPolyPrice <= (thr.maxEntryPolyPrice ?? 0.65);
            gateRows.push(['Entry Px', c(entryPolyPrice), pass(epOk), `<= ${c(thr.maxEntryPolyPrice ?? 0.65)}`]);
          } else {
            gateRows.push(['Entry Px', '—', na, `<= ${c(thr.maxEntryPolyPrice ?? 0.65)}`]);
          }

          // Opposite price
          if (oppPolyPrice != null) {
            const opOk = oppPolyPrice >= (thr.minOppositePolyPrice ?? 0.10);
            gateRows.push(['Opp Px', c(oppPolyPrice), pass(opOk), `>= ${c(thr.minOppositePolyPrice ?? 0.10)}`]);
          }

          // Time
          if (tlm != null) {
            const timeOk = tlm >= (thr.noEntryFinalMinutes ?? 1.5);
            gateRows.push(['Time', `${tlm.toFixed(1)}m`, pass(timeOk), `>= ${thr.noEntryFinalMinutes ?? 1.5}m`]);
          }

          // Candles
          const candleOk = cc >= (thr.minCandlesForEntry ?? 12);
          gateRows.push(['Candles', String(cc), pass(candleOk), `>= ${thr.minCandlesForEntry ?? 12}`]);

          // Poly price bounds (overall min/max — different from entry price cap)
          if (entryPolyPrice != null) {
            const minPoly = thr.minPolyPrice ?? 0.05;
            const maxPoly = thr.maxPolyPrice ?? 0.95;
            const boundsOk = entryPolyPrice >= minPoly && entryPolyPrice <= maxPoly;
            gateRows.push(['Poly Bounds', c(entryPolyPrice), pass(boundsOk), `${c(minPoly)} – ${c(maxPoly)}`]);
          }

          // ── Guardrail gate rows (data from statusData.guardrails) ──
          const gr = statusData.guardrails;
          if (gr) {
            // Loss cooldown
            if ((thr.lossCooldownSeconds ?? 0) > 0) {
              const lcdOk = !gr.lossCooldownActive;
              const lcdText = gr.lossCooldownActive ? `${(gr.lossCooldownRemainingMs / 1000).toFixed(0)}s left` : 'Clear';
              gateRows.push(['Loss CD', lcdText, pass(lcdOk), `${thr.lossCooldownSeconds}s after loss`]);
            }

            // Win cooldown
            if ((thr.winCooldownSeconds ?? 0) > 0) {
              const wcdOk = !gr.winCooldownActive;
              const wcdText = gr.winCooldownActive ? `${(gr.winCooldownRemainingMs / 1000).toFixed(0)}s left` : 'Clear';
              gateRows.push(['Win CD', wcdText, pass(wcdOk), `${thr.winCooldownSeconds}s after win`]);
            }

            // Circuit breaker
            if ((thr.circuitBreakerConsecutiveLosses ?? 0) > 0) {
              const cbOk = !gr.circuitBreakerTripped;
              const cbText = gr.circuitBreakerTripped
                ? `TRIPPED (${(gr.circuitBreakerRemainingMs / 1000).toFixed(0)}s left)`
                : `${gr.consecutiveLosses} losses`;
              gateRows.push(['Circuit Brk', cbText, pass(cbOk), `< ${thr.circuitBreakerConsecutiveLosses} consecutive`]);
            }

            // Schedule (weekdays only)
            if (gr.weekdaysOnly) {
              const schedOk = !( // mirrors entryGate.js check 10
                (thr.isWeekend && !(thr.pacificDay === 'Sun' && thr.pacificHour >= 15)) // allowSundayAfterHour default
                || (thr.pacificDay === 'Fri' && thr.pacificHour >= 17) // noEntryAfterFridayHour default
              );
              gateRows.push(['Schedule', `${thr.pacificDay} ${thr.pacificHour}:00 PT`, pass(schedOk), 'Weekdays only']);
            }

            // Skip market after max loss
            if (gr.skipMarketSlug) {
              const skipOk = gr.skipMarketSlug !== (rt.marketSlug || '');
              gateRows.push(['Skip Mkt', gr.skipMarketSlug === (rt.marketSlug || '') ? 'Same market' : 'New market', pass(skipOk), 'Wait for next 5m']);
            }
          }

          // Kill-switch
          const ks = statusData.killSwitch;
          if (ks) {
            const ksOk = !ks.triggered;
            const ksText = ks.triggered ? `$${(ks.todayPnl ?? 0).toFixed(2)} (HALTED)` : `$${(ks.todayPnl ?? 0).toFixed(2)}`;
            gateRows.push(['Kill Switch', ksText, pass(ksOk), `> -$${Math.abs(thr.maxDailyLossUsd ?? 50).toFixed(0)}`]);
          }

          // BTC Volume
          const volRecent = rt.volumeRecent;
          const volAvg = rt.volumeAvg;
          if (volRecent != null && (thr.minVolumeRecent > 0 || thr.minVolumeRatio > 0)) {
            const absOk = !(thr.minVolumeRecent > 0 && volRecent < thr.minVolumeRecent);
            const relOk = !(thr.minVolumeRatio > 0 && volAvg != null && volRecent < volAvg * thr.minVolumeRatio);
            const volOk = absOk && relOk;
            const volText = volAvg != null ? `${volRecent.toFixed(1)} (avg ${volAvg.toFixed(1)})` : `${volRecent.toFixed(1)}`;
            const reqText = thr.minVolumeRatio > 0 ? `ratio >= ${thr.minVolumeRatio}` : `>= ${thr.minVolumeRecent}`;
            gateRows.push(['BTC Vol', volText, pass(volOk), reqText]);
          }

          // Market Volume
          const mktVol = rt.marketVolumeNum;
          if (mktVol != null && (thr.minMarketVolumeNum ?? 0) > 0) {
            const mktVolOk = mktVol >= thr.minMarketVolumeNum;
            gateRows.push(['Mkt Vol', `$${Number(mktVol).toLocaleString()}`, pass(mktVolOk), `>= $${Number(thr.minMarketVolumeNum).toLocaleString()}`]);
          }

          // Weekend tightening badge
          if (wknd) {
            rows.push(['Schedule', `<span class="threshold-wknd">WEEKEND tightening (${thr.pacificDay} ${thr.pacificHour}:00 PT)</span>`]);
          }

          // Build gate table HTML
          const passCount = gateRows.filter(r => r[2].includes('PASS')).length;
          const failCount = gateRows.filter(r => r[2].includes('FAIL')).length;
          const gateHeader = `<span style="font-weight:600">${passCount} pass</span> / <span style="color:var(--bad);font-weight:600">${failCount} fail</span>`;

          const gateHtml = `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:4px"><thead><tr style="opacity:0.5;font-size:11px"><td>Check</td><td>Current</td><td></td><td>Required</td></tr></thead><tbody>` +
            gateRows.map(([label, current, status, threshold]) =>
              `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)"><td style="padding:2px 6px 2px 0;opacity:0.6">${label}</td><td style="padding:2px 6px;font-family:monospace">${current}</td><td style="padding:2px 4px;text-align:center">${status}</td><td style="padding:2px 6px;opacity:0.5;font-family:monospace">${threshold}</td></tr>`
            ).join('') +
            `</tbody></table>`;

          rows.push(['Gate Status', `${gateHeader}${gateHtml}`]);

          // Guardrails (compact)
          rows.push(['Guardrails', `circuit ${thr.circuitBreakerConsecutiveLosses} losses · daily loss $${thr.maxDailyLossUsd} · cooldown L${thr.lossCooldownSeconds}s / W${thr.winCooldownSeconds}s`]);
        }

        statusMessage.innerHTML = `<table class="kv-table"><tbody>` +
          rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('') +
          `</tbody></table>`;
      }

      // Open trade panel
      if (mode === 'LIVE') {
        // In LIVE mode, show open orders (best-effort) instead of paper open trade.
        try {
          const [oRes, pRes] = await Promise.all([
            fetch('/api/live/open-orders'),
            fetch('/api/live/positions')
          ]);
          const openJson = await oRes.json();
          const posJson = await pRes.json();
          const open = openJson.success ? openJson.data : openJson;
          const pos = posJson.success ? posJson.data : posJson;

          const openCount = Array.isArray(open) ? open.length : (open?.count ?? 0);
          const firstOpen = Array.isArray(open) ? open[0] : null;

          const positions = Array.isArray(pos?.tradable) ? pos.tradable : (Array.isArray(pos) ? pos : []);
          const nonTradableCount = (typeof pos?.nonTradableCount === 'number') ? pos.nonTradableCount : 0;
          const firstPos = positions[0] || null;

          openTradeDiv.textContent =
            `LIVE Open Orders: ${openCount}\n` +
            (firstOpen ? (`\nFirst Order:\n` +
              `  id: ${String(firstOpen.id || '').slice(0, 10)}\n` +
              `  side: ${firstOpen.side || 'N/A'}\n` +
              `  price: ${firstOpen.price || 'N/A'}\n` +
              `  size: ${firstOpen.original_size || firstOpen.size || 'N/A'}\n`) : '') +
            `\nLIVE Positions (tradable): ${positions.length}` +
            (nonTradableCount ? `  | non-tradable: ${nonTradableCount}` : '') +
            `\n` +
            (firstPos ? (`\nFirst Position:\n` +
              `  token: ${String(firstPos.tokenID || '').slice(0, 10)}...\n` +
              `  outcome: ${firstPos.outcome || 'N/A'}\n` +
              `  qty: ${Number(firstPos.qty || 0).toFixed(4)}\n` +
              `  avgEntry: ${firstPos.avgEntry != null ? (Number(firstPos.avgEntry) * 100).toFixed(2) + '¢' : 'N/A'}\n` +
              `  mark: ${firstPos.mark != null ? (Number(firstPos.mark) * 100).toFixed(2) + '¢' : 'N/A'}\n` +
              `  uPnL: ${firstPos.unrealizedPnl != null ? ('$' + Number(firstPos.unrealizedPnl).toFixed(2)) : 'N/A'}\n`) : '');

          openTradeDiv.classList.remove('closed');
        } catch {
          openTradeDiv.textContent = 'LIVE: unable to load open orders / positions.';
          openTradeDiv.classList.add('closed');
        }
      } else if (statusData.openTrade) {
        const t = statusData.openTrade;
        const cur = (t.side === 'UP') ? (rt?.polyUp != null ? Number(rt.polyUp) : null) : (rt?.polyDown != null ? Number(rt.polyDown) : null);
        let uPnl = 'N/A';
        if (cur != null && t.entryPrice != null && t.contractSize != null) {
          const shares = (t.shares != null) ? Number(t.shares) : (t.entryPrice > 0 ? (t.contractSize / t.entryPrice) : null);
          if (shares != null && Number.isFinite(shares)) {
            const value = shares * cur;
            const pnl = value - t.contractSize;
            uPnl = '$' + pnl.toFixed(2);
          }
        }

        openTradeDiv.textContent =
          `ID: ${t.id?.slice(0, 8) || 'N/A'}\n` +
          `Side: ${t.side}\n` +
          `Entry: ${formatCents(t.entryPrice)}¢\n` +
          `Current: ${cur != null ? formatCents(cur) + '¢' : 'N/A'}\n` +
          `Unrealized PnL: ${uPnl}\n` +
          `Contract: $${formatCurrency(t.contractSize)}\n` +
          `Phase: ${t.entryPhase || 'N/A'}\n` +
          `Status: ${t.status}`;

        openTradeDiv.classList.remove('closed');
      } else {
        openTradeDiv.textContent = 'No open trade.';
        openTradeDiv.classList.add('closed');
      }

      // ── Phase 3: Kill-Switch Panel ──────────────────────────────
      // Fields from TradingState.getKillSwitchStatus():
      //   active (bool), overrideActive (bool), overrideCount (num),
      //   todayPnl (num), limit (num), lastResetDate, overrideLog
      const ks = statusData.killSwitch;
      if (ks && ksPnlLabel) {
        const dailyPnl = typeof ks.todayPnl === 'number' ? ks.todayPnl : 0;
        const maxLoss = typeof ks.limit === 'number' ? Math.abs(ks.limit) : 0;

        // PnL label
        const pnlSign = dailyPnl >= 0 ? '+' : '';
        ksPnlLabel.textContent = `Daily PnL: ${pnlSign}$${formatCurrency(dailyPnl)}` +
          (maxLoss > 0 ? ` / -$${formatCurrency(maxLoss)} limit` : '');
        ksPnlLabel.style.color = dailyPnl >= 0 ? 'var(--good)' : 'var(--bad)';

        // Progress bar — shows how much of the daily loss budget has been consumed
        if (ksProgressBar && maxLoss > 0) {
          const consumed = Math.max(0, -dailyPnl);
          const pct = Math.min(100, (consumed / maxLoss) * 100);
          ksProgressBar.style.width = pct + '%';
          ksProgressBar.classList.remove('ks-warn', 'ks-danger');
          if (pct >= 100) {
            ksProgressBar.classList.add('ks-danger');
          } else if (pct >= 70) {
            ksProgressBar.classList.add('ks-warn');
          }
        }

        // Banner — triggered or overridden
        if (ksBanner) {
          if (ks.active && !ks.overrideActive) {
            ksBanner.className = 'ks-banner ks-banner--active';
            ksBanner.textContent = 'KILL-SWITCH ACTIVE — Trading halted';
          } else if (ks.overrideActive) {
            ksBanner.className = 'ks-banner ks-banner--overridden';
            ksBanner.textContent = `KILL-SWITCH OVERRIDDEN (${ks.overrideCount || 1}x) — Reduced budget active`;
          } else {
            ksBanner.className = 'ks-banner ks-banner--hidden';
          }
        }

        // Override button — only show when triggered and NOT yet overridden
        if (ksOverrideSection) {
          ksOverrideSection.style.display = (ks.active && !ks.overrideActive) ? '' : 'none';
        }
      } else if (ksPnlLabel) {
        ksPnlLabel.textContent = 'Daily PnL: --';
        ksPnlLabel.style.color = '';
        if (ksProgressBar) ksProgressBar.style.width = '0%';
        if (ksBanner) ksBanner.className = 'ks-banner ks-banner--hidden';
        if (ksOverrideSection) ksOverrideSection.style.display = 'none';
      }

      // ── Phase 3: Order Lifecycle Panel ──────────────────────────
      const olcOrders = statusData.orderLifecycle;
      if (orderLifecycleCard && orderLifecyclePanel) {
        if (Array.isArray(olcOrders) && olcOrders.length > 0) {
          orderLifecycleCard.style.display = '';
          const nowMs = Date.now();
          const olcHtml = olcOrders.map(o => {
            const oid = String(o.orderId || '').slice(0, 10);
            const state = o.state || 'UNKNOWN';
            const side = o.side || '';
            // Compute age from SUBMITTED timestamp
            const submittedMs = o.timestamps?.SUBMITTED;
            const age = submittedMs ? Math.round((nowMs - submittedMs) / 1000) + 's' : '';
            const fillInfo = o.fillRatio != null && o.fillRatio > 0 && o.fillRatio < 1
              ? ` (${Math.round(o.fillRatio * 100)}% filled)` : '';
            const errInfo = o.error ? ` ERR: ${o.error}` : '';
            return `<div style="margin-bottom:6px">` +
              `<span class="lifecycle-badge lifecycle-badge--${state}">${state}</span> ` +
              `<span style="color:var(--muted)">${oid}${side ? ' ' + side : ''}${age ? ' ' + age : ''}${fillInfo}${errInfo}</span>` +
              `</div>`;
          }).join('');
          orderLifecyclePanel.innerHTML = olcHtml;
        } else {
          orderLifecycleCard.style.display = 'none';
          orderLifecyclePanel.textContent = 'No active orders.';
        }
      }

      // ── Phase 3: Sync Indicator (Reconciliation) ────────────────
      const recon = statusData.reconciliation;
      if (ksSyncIndicator) {
        if (recon) {
          const syncStatus = recon.status || 'checking';
          ksSyncIndicator.className = `sync-dot sync-dot--${syncStatus}`;
          const discCount = Array.isArray(recon.discrepancies) ? recon.discrepancies.length : 0;
          if (syncStatus === 'in_sync') {
            ksSyncIndicator.title = 'Reconciliation: in sync';
          } else if (syncStatus === 'discrepancy') {
            ksSyncIndicator.title = `Reconciliation: ${discCount} discrepanc${discCount === 1 ? 'y' : 'ies'}`;
          } else {
            ksSyncIndicator.title = 'Reconciliation: checking';
          }
        } else {
          ksSyncIndicator.className = 'sync-dot sync-dot--checking';
          ksSyncIndicator.title = 'Reconciliation: no data';
        }
      }

      // Ledger summary
      const summary = statusData.ledgerSummary || { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, winRate: 0 };
      const bal = statusData.balance || { starting: 0, realized: 0, balance: 0 };
      const pt = statusData.paperTrading || {};
      const lt = statusData.liveTrading || {};

      const liveBalBase = Number(lt?.collateral?.balance ?? 0);
      const liveBalUsd = Number.isFinite(liveBalBase) ? (liveBalBase / 1e6) : 0;

      if (mode === 'LIVE') {
        ledgerSummaryDiv.textContent =
          `MODE: LIVE (CLOB)\n` +
          `Funder: ${lt.funder || 'N/A'}\n` +
          `SignatureType: ${lt.signatureType ?? 'N/A'}\n` +
          `\n` +
          `CLOB Collateral: $${formatCurrency(liveBalUsd)}\n` +
          `Max/Trade:       $${formatCurrency(lt?.limits?.maxPerTradeUsd ?? 0)}\n` +
          `Max Exposure:    $${formatCurrency(lt?.limits?.maxOpenExposureUsd ?? 0)}\n` +
          `Max Daily Loss:  $${formatCurrency(lt?.limits?.maxDailyLossUsd ?? 0)}\n`;

        // KPIs (LIVE) — keep simple
        setKpi(kpiBalance, '$' + formatCurrency(liveBalUsd), null);
        setKpi(kpiRealized, 'Realized: (available via /api/live/analytics)', null);
        setKpi(kpiWinrate, '—', null);
        setKpi(kpiProfitFactor, 'PF: —', null);

        // Disable charts in LIVE mode
        updateEquityCurve([], 0);
      } else {
        ledgerSummaryDiv.textContent =
          `MODE: PAPER\n` +
          `Starting Balance: $${formatCurrency(bal.starting ?? 0)}\n` +
          `Current Balance:  $${formatCurrency(bal.balance ?? 0)}\n` +
          `Realized PnL:     $${formatCurrency(bal.realized ?? 0)}\n` +
          `Stake %:          ${pt.stakePct != null ? formatPercentage(Number(pt.stakePct) * 100, 1) : 'N/A'}\n` +
          `Min/Max Trade:    $${formatCurrency(pt.minTradeUsd ?? 0)} / $${formatCurrency(pt.maxTradeUsd ?? 0)}\n` +
          `\n` +
          `Total Trades: ${summary.totalTrades ?? 0}\n` +
          `Wins: ${summary.wins ?? 0}\n` +
          `Losses: ${summary.losses ?? 0}\n` +
          `Total PnL: $${formatCurrency(summary.totalPnL ?? 0)}\n` +
          `Win Rate: ${formatPercentage(summary.winRate ?? 0)}`;

        // KPIs (PAPER)
        setKpi(kpiBalance, '$' + formatCurrency(bal.balance ?? 0), null);
        setKpi(kpiRealized, 'Realized: $' + formatCurrency(bal.realized ?? 0), (Number(bal.realized) >= 0 ? 'positive' : 'negative'));
        setKpi(kpiWinrate, formatPercentage(summary.winRate ?? 0), null);

        // update equity chart using STARTING balance (not current) to show curve
        updateEquityCurve(lastTradesCache, Number(bal.starting ?? 0) + 0);
      }

    } catch (error) {
      if (error?.message === '__skip_status__') {
        // Intentional skip — foreign instance detected, fall through to trades.
      } else {
        // On transient fetch errors, preserve last good UI data instead of
        // overwriting with error messages (prevents flash/flicker with load-balanced instances).
        console.error('Error fetching status data:', error);
        if (!lastStatusCache) {
          const msg = (error && error.message) ? error.message : String(error);
          statusMessage.textContent = `Error loading status data: ${msg}`;
          openTradeDiv.textContent = `Error loading trade data: ${msg}`;
          ledgerSummaryDiv.textContent = `Error loading summary data: ${msg}`;
        }
      }
    }

    // ---- trades ----
    try {
      // Use dropdown as single source of truth (matches first-poll-only sync)
      const modeNow = (modeSelect?.value || 'paper').toUpperCase();
      const tradesUrl = modeNow === 'LIVE' ? '/api/live/trades' : '/api/trades';
      const tradesResponse = await fetch(tradesUrl);
      const tradesJson = await tradesResponse.json();
      if (!tradesResponse.ok || !tradesJson.success) throw new Error(tradesJson.error || 'trades endpoint failed');
      const trades = tradesJson.data;
      lastTradesCache = Array.isArray(trades) ? trades : [];

      // Render trades table
      if (modeNow === 'LIVE') {
        const rows = lastTradesCache
          .slice() // copy
          .reverse() // newest first
          .slice(0, Number(tradesLimitSel?.value || 50));

        if (recentTradesBody) {
          recentTradesBody.innerHTML = rows.length
            ? rows.map(t => {
                const ts = t.match_time ? new Date(Number(t.match_time) * 1000).toLocaleTimeString() : '';
                return `<tr>` +
                  `<td>${ts}</td>` +
                  `<td>${t.outcome || ''}</td>` +
                  `<td>${t.side || ''}</td>` +
                  `<td>${t.size || ''}</td>` +
                  `<td>${t.price || ''}</td>` +
                  `<td>${t.status || ''}</td>` +
                `</tr>`;
              }).join('')
            : '<tr><td colspan="6">No live trades yet.</td></tr>';
        }

        // Don't run paper-only rendering/filters/histograms in LIVE mode.
        return;
      }

      // In LIVE mode, the trade objects differ (CLOB schema). Skip paper-only filters/KPIs.
      if (modeNow !== 'LIVE') {
        refreshReasonFilter(lastTradesCache);

        // Today/yesterday KPIs (paper closed trades)
        const keyToday = todayKey();
        const keyYesterday = yesterdayKey();
        const buckets = { [keyToday]: { pnl: 0, n: 0 }, [keyYesterday]: { pnl: 0, n: 0 } };
        for (const t of lastTradesCache) {
          if (!t || t.status !== 'CLOSED') continue;
          const ts = t.exitTime || t.timestamp || t.entryTime;
          if (!ts) continue;
          const dk = dayKey(ts);
          if (!buckets[dk]) continue;
          buckets[dk].pnl += (Number(t.pnl) || 0);
          buckets[dk].n += 1;
        }

        setKpi(kpiPnlToday, '$' + formatCurrency(buckets[keyToday].pnl, 2), buckets[keyToday].pnl >= 0 ? 'positive' : 'negative');
        setKpi(kpiTradesToday, `Trades: ${buckets[keyToday].n}`, null);
        setKpi(kpiPnlYesterday, '$' + formatCurrency(buckets[keyYesterday].pnl, 2), buckets[keyYesterday].pnl >= 0 ? 'positive' : 'negative');
        setKpi(kpiTradesYesterday, `Trades: ${buckets[keyYesterday].n}`, null);

        // Profit factor from closed trades
        const closedForPf = lastTradesCache.filter(t => t && t.status === 'CLOSED');
        const grossWins = closedForPf.reduce((s, t) => s + Math.max(0, Number(t.pnl) || 0), 0);
        const grossLosses = Math.abs(closedForPf.reduce((s, t) => s + Math.min(0, Number(t.pnl) || 0), 0));
        const pf = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : (grossWins > 0 ? '∞' : 'N/A');
        setKpi(kpiProfitFactor, `PF: ${pf}`, null);
      }

      renderTradesTable();

    } catch (error) {
      // On transient errors, preserve last good trades data (prevents flashing).
      console.error('Error fetching trades:', error);
      if (!lastTradesCache || lastTradesCache.length === 0) {
        recentTradesBody.innerHTML = '<tr><td colspan="8">Error loading trades.</td></tr>';
      }
      // else: keep last rendered trades visible
    }
  };

  // Filter events
  const rerender = () => { try { renderTradesTable(); } catch {} };
  tradesLimitSel?.addEventListener('change', rerender);
  tradesReasonSel?.addEventListener('change', rerender);
  tradesSideSel?.addEventListener('change', rerender);
  tradesOnlyLosses?.addEventListener('change', rerender);

  fetchData();
  setInterval(fetchData, 1500);
});

