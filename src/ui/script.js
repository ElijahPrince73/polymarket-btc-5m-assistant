document.addEventListener('DOMContentLoaded', () => {
    const statusMessage = document.getElementById('status-message');
    const openTradeDiv = document.getElementById('open-trade');
    const ledgerSummaryDiv = document.getElementById('ledger-summary');

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

    // Function to format currency and percentages
    const formatCurrency = (value, decimals = 2) => value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const formatPercentage = (value, decimals = 2) => value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';

    // Polymarket prices can be tiny (sub-1¢). Use adaptive decimals.
    const formatCents = (dollars) => {
        if (dollars == null || !Number.isFinite(Number(dollars))) return 'N/A';
        const cents = Number(dollars) * 100;
        const decimals = cents < 1 ? 4 : 2;
        return cents.toFixed(decimals);
    };

    // Function to fetch and display data
    const fetchData = async () => {
        try {
            // Fetch status (live signal, open trade)
            const statusResponse = await fetch('/api/status');
            const statusData = await statusResponse.json();

            // Very simple status text
            if (!statusResponse.ok) {
                throw new Error('status endpoint returned non-200');
            }
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

            if (statusData.openTrade) {
                const t = statusData.openTrade;
                const rt = statusData.runtime;
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

            // Fetch ledger summary
            const summary = statusData.ledgerSummary || { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, winRate: 0 };
            const bal = statusData.balance || { starting: 0, realized: 0, balance: 0 };
            const pt = statusData.paperTrading || {};
            ledgerSummaryDiv.textContent =
                `Starting Balance: $${formatCurrency(bal.starting ?? 0)}\n` +
                `Current Balance:  $${formatCurrency(bal.balance ?? 0)}\n` +
                `Realized PnL:     $${formatCurrency(bal.realized ?? 0)}\n` +
                `Stake %:          ${pt.stakePct != null ? formatPercentage(Number(pt.stakePct) * 100, 1) : 'N/A'}\n` +
                `Min/Max Trade:    $${formatCurrency(pt.minTradeUsd ?? 0)} / $${formatCurrency(pt.maxTradeUsd ?? 0)}\n` +
                `Stop Loss:        ${pt.stopLossPct != null ? formatPercentage(Number(pt.stopLossPct) * 100, 1) : 'N/A'}\n` +
                `Flip Enabled:     ${pt.flipOnProbabilityFlip != null ? String(pt.flipOnProbabilityFlip) : 'N/A'}\n` +
                `\n` +
                `Total Trades: ${summary.totalTrades ?? 0}\n` +
                `Wins: ${summary.wins ?? 0}\n` +
                `Losses: ${summary.losses ?? 0}\n` +
                `Total PnL: $${formatCurrency(summary.totalPnL ?? 0)}\n` +
                `Win Rate: ${formatPercentage(summary.winRate ?? 0)}`;

        } catch (error) {
            const msg = (error && error.message) ? error.message : String(error);
            statusMessage.textContent = `Error loading status data: ${msg}`;
            openTradeDiv.textContent = `Error loading trade data: ${msg}`;
            ledgerSummaryDiv.textContent = `Error loading summary data: ${msg}`;
            console.error('Error fetching status data:', error);
        }

        // Fetch analytics
        try {
            const aRes = await fetch('/api/analytics');
            const analytics = await aRes.json();
            if (!aRes.ok) throw new Error('analytics endpoint returned non-200');

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

            const renderGroup = (tbody, rows) => {
                if (!tbody) return;
                if (!rows || !Array.isArray(rows) || rows.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3">No data.</td></tr>';
                    return;
                }
                const r = rows.slice(0, 12);
                tbody.innerHTML = r.map((x) => {
                    const pnl = (typeof x.pnl === 'number' && Number.isFinite(x.pnl)) ? x.pnl : 0;
                    const cls = pnl >= 0 ? 'positive' : 'negative';
                    return `<tr><td>${x.key}</td><td class="num">${x.count}</td><td class="num ${cls}">${fmt(pnl)}</td></tr>`;
                }).join('');
            };

            renderGroup(analyticsByExitBody, analytics.byExitReason);
            renderGroup(analyticsByPhaseBody, analytics.byEntryPhase);
            renderGroup(analyticsByPriceBody, analytics.byEntryPriceBucket);
            renderGroup(analyticsByInferredBody, analytics.bySideInferred);
            renderGroup(analyticsByTimeLeftBody, analytics.byEntryTimeLeftBucket);
            renderGroup(analyticsByProbBody, analytics.byEntryProbBucket);
            renderGroup(analyticsByLiqBody, analytics.byEntryLiquidityBucket);
            renderGroup(analyticsByMktVolBody, analytics.byEntryMarketVolumeBucket);
            renderGroup(analyticsBySpreadBody, analytics.byEntrySpreadBucket);
            renderGroup(analyticsByEdgeBody, analytics.byEntryEdgeBucket);
            renderGroup(analyticsByVwapDistBody, analytics.byEntryVwapDistBucket);
            renderGroup(analyticsByRsiBody, analytics.byEntryRsiBucket);
            renderGroup(analyticsByHoldBody, analytics.byHoldTimeBucket);
            renderGroup(analyticsByMaeBody, analytics.byMAEBucket);
            renderGroup(analyticsByMfeBody, analytics.byMFEBucket);
            renderGroup(analyticsBySideBody, analytics.bySide);
            renderGroup(analyticsByRecBody, analytics.byRecActionAtEntry);
        } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            if (analyticsOverviewDiv) analyticsOverviewDiv.textContent = `Error loading analytics: ${msg}`;
            if (analyticsByExitBody) analyticsByExitBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByPhaseBody) analyticsByPhaseBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByPriceBody) analyticsByPriceBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByInferredBody) analyticsByInferredBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByTimeLeftBody) analyticsByTimeLeftBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByProbBody) analyticsByProbBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByLiqBody) analyticsByLiqBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByMktVolBody) analyticsByMktVolBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsBySpreadBody) analyticsBySpreadBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByEdgeBody) analyticsByEdgeBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByVwapDistBody) analyticsByVwapDistBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByRsiBody) analyticsByRsiBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByHoldBody) analyticsByHoldBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByMaeBody) analyticsByMaeBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByMfeBody) analyticsByMfeBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsBySideBody) analyticsBySideBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
            if (analyticsByRecBody) analyticsByRecBody.innerHTML = '<tr><td colspan="3">Error</td></tr>';
        }

        // Fetch recent trades
        try {
            const tradesResponse = await fetch('/api/trades');
            const trades = await tradesResponse.json();
            
            if (Array.isArray(trades) && trades.length > 0) {
                // Display only the last N trades for brevity, newest first
                const tradesToDisplay = trades.slice(-10).reverse();

                const rowsHtml = tradesToDisplay.map((trade) => {
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
            } else {
                recentTradesBody.innerHTML = '<tr><td colspan="8">No trades recorded yet.</td></tr>';
            }
        } catch (error) {
            recentTradesBody.innerHTML = '<tr><td colspan="8">Error loading recent trades.</td></tr>';
            console.error('Error fetching recent trades:', error);
        }
    };

    // Fetch data every 5 seconds
    fetchData();
    setInterval(fetchData, 5000); 
});
