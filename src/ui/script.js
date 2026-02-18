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

  // top right pill
  const uiPortPill = document.getElementById('ui-port-pill');
  if (uiPortPill) {
    const p = window.location.port ? `:${window.location.port}` : '';
    uiPortPill.textContent = `UI${p}`;
  }

  // Analytics elements
  const analyticsOverviewDiv = document.getElementById('analytics-overview');
  const analyticsByExitBody = document.getElementById('analytics-by-exit');
  const analyticsByPhaseBody = document.getElementById('analytics-by-phase');
  const analyticsByPriceBody = document.getElementById('analytics-by-price');
  const analyticsByInferredBody = document.getElementById('analytics-by-inferred');
  const analyticsByTimeLeftBody = document.getElementById('analytics-by-timeleft');
  const analyticsByProbBody = document.getElementById('analytics-by-prob');
  const analyticsByLiqBody = document.getElementById('analytics-by-liq');
  const analyticsByMktVolBody = document.getElementById('analytics-by-mktvol');
  const analyticsBySpreadBody = document.getElementById('analytics-by-spread');
  const analyticsByEdgeBody = document.getElementById('analytics-by-edge');
  const analyticsByVwapDistBody = document.getElementById('analytics-by-vwapdist');
  const analyticsByRsiBody = document.getElementById('analytics-by-rsi');
  const analyticsByHoldBody = document.getElementById('analytics-by-hold');
  const analyticsByMaeBody = document.getElementById('analytics-by-mae');
  const analyticsByMfeBody = document.getElementById('analytics-by-mfe');
  const analyticsBySideBody = document.getElementById('analytics-by-side');
  const analyticsByRecBody = document.getElementById('analytics-by-rec');

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
  let chartExit = null;
  let chartEntryPrice = null;
  let chartPnlHist = null;

  const chartColors = {
    good: '#2ee59d',
    bad: '#ff5c7a',
    accent: '#6ea8ff',
    muted: 'rgba(231,238,252,0.45)',
    grid: 'rgba(255,255,255,0.08)'
  };

  const ensureCharts = () => {
    if (!window.Chart) return;

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

    const exitEl = document.getElementById('chart-exit');
    if (exitEl && !chartExit) {
      chartExit = new Chart(exitEl, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'PnL', data: [], backgroundColor: [] }] },
        options: { ...baseOpts, plugins: { ...baseOpts.plugins, legend: { display: false } } }
      });
    }

    const entryEl = document.getElementById('chart-entry-price');
    if (entryEl && !chartEntryPrice) {
      chartEntryPrice = new Chart(entryEl, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'PnL', data: [], backgroundColor: [] }] },
        options: { ...baseOpts, plugins: { ...baseOpts.plugins, legend: { display: false } } }
      });
    }

    const histEl = document.getElementById('chart-pnl-hist');
    if (histEl && !chartPnlHist) {
      chartPnlHist = new Chart(histEl, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Count', data: [], backgroundColor: 'rgba(231,238,252,0.18)' }] },
        options: { ...baseOpts, plugins: { ...baseOpts.plugins, legend: { display: false } }, scales: { ...baseOpts.scales, y: { ...baseOpts.scales.y, beginAtZero: true } } }
      });
    }
  };

  const updateBarChart = (chart, rows, { maxBars = 12 } = {}) => {
    if (!chart || !rows || !Array.isArray(rows)) return;
    const r = rows.slice(0, maxBars);
    chart.data.labels = r.map(x => x.key);
    chart.data.datasets[0].data = r.map(x => (typeof x.pnl === 'number' ? x.pnl : 0));
    chart.data.datasets[0].backgroundColor = r.map(x => ((x.pnl ?? 0) >= 0) ? 'rgba(46,229,157,0.55)' : 'rgba(255,92,122,0.55)');
    chart.update('none');
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

  const updatePnlHistogram = (trades, { limit = 200, bins = 18 } = {}) => {
    if (!chartPnlHist) return;
    const closed = (Array.isArray(trades) ? trades : []).filter(t => t.status === 'CLOSED');
    const tail = closed.slice(Math.max(0, closed.length - limit));
    const pnls = tail.map(t => Number(t.pnl) || 0);
    if (!pnls.length) return;

    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    const span = Math.max(1e-9, max - min);
    const step = span / bins;
    const counts = new Array(bins).fill(0);
    for (const p of pnls) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((p - min) / step)));
      counts[idx] += 1;
    }

    const labels = counts.map((_, i) => {
      const a = min + i * step;
      const b = min + (i + 1) * step;
      return `${a.toFixed(0)}..${b.toFixed(0)}`;
    });

    chartPnlHist.data.labels = labels;
    chartPnlHist.data.datasets[0].data = counts;
    chartPnlHist.update('none');
  };

  const setKpi = (el, text, cls = null) => {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
  };

  const renderGroupTable = (tbody, rows) => {
    if (!tbody) return;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3">No data.</td></tr>';
      return;
    }
    const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(d) : 'N/A';
    const r = rows.slice(0, 12);
    tbody.innerHTML = r.map((x) => {
      const pnl = (typeof x.pnl === 'number' && Number.isFinite(x.pnl)) ? x.pnl : 0;
      const cls = pnl >= 0 ? 'positive' : 'negative';
      return `<tr><td>${x.key}</td><td class="num">${x.count}</td><td class="num ${cls}">${fmt(pnl)}</td></tr>`;
    }).join('');
  };

  let lastTradesCache = [];
  let lastAnalyticsCache = null;
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
  const fetchData = async () => {
    ensureCharts();

    // ---- status ----
    try {
      const statusResponse = await fetch('/api/status');
      const statusData = await statusResponse.json();
      if (!statusResponse.ok) throw new Error('status endpoint returned non-200');
      lastStatusCache = statusData;

      const rt = statusData.runtime;
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
        const entryReason = entryDbg
          ? (entryDbg.eligible
            ? 'ELIGIBLE (will enter if Rec=ENTER + thresholds hit)'
            : (Array.isArray(entryDbg.blockers) && entryDbg.blockers.length
              ? entryDbg.blockers.join('; ')
              : 'Not eligible'))
          : 'N/A';

        const rows = [
          ['Polymarket URL', pmUrl ? `<a href="${pmUrl}" target="_blank" rel="noreferrer">${pmUrl}</a>` : 'N/A'],
          ['Market', rt.marketSlug || 'N/A'],
          ['Time left', timeLeft],
          ['BTC', btc],
          ['Poly UP / DOWN', `${polyUp} / ${polyDown}`],
          ['Model', `${rt.narrative || 'N/A'} (UP ${up} / DOWN ${down})`],
          ['Candles (1m)', String(cc)],
          ['Why no entry?', entryReason]
        ];

        statusMessage.innerHTML = `<table class="kv-table"><tbody>` +
          rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('') +
          `</tbody></table>`;
      }

      // Open trade panel
      if (statusData.openTrade) {
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

      const mode = statusData.mode || 'PAPER';

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

        // KPIs (LIVE)
        setKpi(kpiBalance, '$' + formatCurrency(liveBalUsd), null);
        setKpi(kpiRealized, 'Realized: (live TBD)', null);

        // Equity curve: not wired for live yet.
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

        // update equity chart using STARTING balance (not current) to show curve
        updateEquityCurve(lastTradesCache, Number(bal.starting ?? 0) + 0);
      }

    } catch (error) {
      const msg = (error && error.message) ? error.message : String(error);
      statusMessage.textContent = `Error loading status data: ${msg}`;
      openTradeDiv.textContent = `Error loading trade data: ${msg}`;
      ledgerSummaryDiv.textContent = `Error loading summary data: ${msg}`;
      console.error('Error fetching status data:', error);
    }

    // ---- analytics ----
    try {
      const aRes = await fetch('/api/analytics');
      const analytics = await aRes.json();
      if (!aRes.ok) throw new Error('analytics endpoint returned non-200');
      lastAnalyticsCache = analytics;

      const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(d) : 'N/A';
      const pct = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n)) ? (n * 100).toFixed(d) + '%' : 'N/A';

      const top = analytics?.overview || {};
      const liq = analytics?.liquidity || {};
      const liq24 = liq.last24h || {};

      const liqLine = (label, obj) => {
        if (!obj || obj.avg == null) return `${label}: N/A`;
        return `${label}: avg=${Math.round(obj.avg)} (n=${obj.samples ?? 0}, p50=${obj.p50 != null ? Math.round(obj.p50) : 'N/A'})`;
      };

      analyticsOverviewDiv.textContent = [
        `Closed Trades: ${top.closedTrades ?? 0}`,
        `Wins / Losses: ${(top.wins ?? 0)} / ${(top.losses ?? 0)}`,
        `Total PnL: $${fmt(top.totalPnL)}`,
        `Win Rate: ${pct(top.winRate)}`,
        `Avg Win: $${fmt(top.avgWin)}`,
        `Avg Loss: $${fmt(top.avgLoss)}`,
        `Profit Factor: ${fmt(top.profitFactor)}`,
        `Expectancy / trade: $${fmt(top.expectancy)}`,
        '',
        `Polymarket liquidity (sampled):`,
        liqLine('Last 1h', liq.last1h),
        liqLine('Last 6h', liq.last6h),
        liqLine('Last 24h', liq24)
      ].join('\n');

      // KPI winrate + PF
      setKpi(kpiWinrate, pct(top.winRate), null);
      setKpi(kpiProfitFactor, `PF: ${fmt(top.profitFactor, 2)}`, null);

      renderGroupTable(analyticsByExitBody, analytics.byExitReason);
      renderGroupTable(analyticsByPhaseBody, analytics.byEntryPhase);
      renderGroupTable(analyticsByPriceBody, analytics.byEntryPriceBucket);
      renderGroupTable(analyticsByInferredBody, analytics.bySideInferred);
      renderGroupTable(analyticsByTimeLeftBody, analytics.byEntryTimeLeftBucket);
      renderGroupTable(analyticsByProbBody, analytics.byEntryProbBucket);
      renderGroupTable(analyticsByLiqBody, analytics.byEntryLiquidityBucket);
      renderGroupTable(analyticsByMktVolBody, analytics.byEntryMarketVolumeBucket);
      renderGroupTable(analyticsBySpreadBody, analytics.byEntrySpreadBucket);
      renderGroupTable(analyticsByEdgeBody, analytics.byEntryEdgeBucket);
      renderGroupTable(analyticsByVwapDistBody, analytics.byEntryVwapDistBucket);
      renderGroupTable(analyticsByRsiBody, analytics.byEntryRsiBucket);
      renderGroupTable(analyticsByHoldBody, analytics.byHoldTimeBucket);
      renderGroupTable(analyticsByMaeBody, analytics.byMAEBucket);
      renderGroupTable(analyticsByMfeBody, analytics.byMFEBucket);
      renderGroupTable(analyticsBySideBody, analytics.bySide);
      renderGroupTable(analyticsByRecBody, analytics.byRecActionAtEntry);

      // Charts
      updateBarChart(chartExit, analytics.byExitReason, { maxBars: 10 });
      updateBarChart(chartEntryPrice, analytics.byEntryPriceBucket, { maxBars: 8 });

    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (analyticsOverviewDiv) analyticsOverviewDiv.textContent = `Error loading analytics: ${msg}`;
      if (analyticsByExitBody) analyticsByExitBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
    }

    // ---- trades ----
    try {
      const tradesResponse = await fetch('/api/trades');
      const trades = await tradesResponse.json();
      if (!tradesResponse.ok) throw new Error('trades endpoint returned non-200');
      lastTradesCache = Array.isArray(trades) ? trades : [];

      refreshReasonFilter(lastTradesCache);

      // Today/yesterday KPIs
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

      updatePnlHistogram(lastTradesCache, { limit: 200, bins: 18 });
      renderTradesTable();

    } catch (error) {
      recentTradesBody.innerHTML = '<tr><td colspan="8">Error loading trades.</td></tr>';
      console.error('Error fetching trades:', error);
    }
  };

  // Filter events
  const rerender = () => { try { renderTradesTable(); } catch {} };
  tradesLimitSel?.addEventListener('change', rerender);
  tradesReasonSel?.addEventListener('change', rerender);
  tradesSideSel?.addEventListener('change', rerender);
  tradesOnlyLosses?.addEventListener('change', rerender);

  fetchData();
  setInterval(fetchData, 5000);
});
