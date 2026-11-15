import React from 'react';
import { createRoot } from 'react-dom/client';
import { SmartChart, setSmartChartsPublicPath, ChartSetting, CrosshairToggle, DrawTools } from '@deriv-com/smartcharts-champion';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import './deriv-smartchart.css';

setSmartChartsPublicPath('/dist/');

function ChartApp() {
    const bridge = window.__derivChartBridge;
    const [chartState, setChartState] = React.useState(() => window.__derivAccumulatorChartState || {});
    const [chartData, setChartData] = React.useState(() => bridge?.getMetadata?.() || null);
    const [connectionOpen, setConnectionOpen] = React.useState(() => !!bridge?.isConnected?.());
    const [chartReady, setChartReady] = React.useState(false);
    const [openPosition, setOpenPosition] = React.useState(() => window.__derivAccumulatorOpenPosition || null);
    const [diagnostic, setDiagnostic] = React.useState(() => window.__derivChartDiagnostic || {
        stage: 'waiting_for_history',
        detail: 'Waiting for SmartCharts to request initial history',
    });
    const isMobile = window.matchMedia('(max-width: 700px)').matches;

    React.useEffect(() => {
        const updateState = event => setChartState(event.detail || {});
        const updateMetadata = event => setChartData(event.detail || null);
        const updateConnection = event => setConnectionOpen(!!event.detail?.connected);
        const updateDiagnostic = event => setDiagnostic(event.detail || { stage: 'unknown', detail: '' });
        const updateOpenPosition = event => setOpenPosition(event.detail || null);

        window.addEventListener('deriv-accumulator-chart-state', updateState);
        window.addEventListener('deriv-chart-metadata', updateMetadata);
        window.addEventListener('deriv-chart-connection', updateConnection);
        window.addEventListener('deriv-chart-diagnostic', updateDiagnostic);
        window.addEventListener('deriv-accumulator-open-position', updateOpenPosition);

        window.__derivChartSetSymbol = symbol => setChartState(current => ({ ...current, symbol }));

        return () => {
            window.removeEventListener('deriv-accumulator-chart-state', updateState);
            window.removeEventListener('deriv-chart-metadata', updateMetadata);
            window.removeEventListener('deriv-chart-connection', updateConnection);
            window.removeEventListener('deriv-chart-diagnostic', updateDiagnostic);
            window.removeEventListener('deriv-accumulator-open-position', updateOpenPosition);
            delete window.__derivChartSetSymbol;
        };
    }, []);

    const symbol = chartState.symbol || '';
    const barrier = chartState.barrier;
    const hasValidBarrier =
        barrier &&
        Number.isFinite(Number(barrier.high)) &&
        Number.isFinite(Number(barrier.low)) &&
        Number(barrier.high) > Number(barrier.low) &&
        Number.isFinite(Number(barrier.spot)) &&
        Number.isFinite(Number(barrier.spotEpoch)) &&
        Number.isFinite(Number(barrier.barrierEpoch));

    const accumulatorBarriers = hasValidBarrier
        ? {
              live: {
                  highBarrier: String(barrier.high),
                  lowBarrier: String(barrier.low),
                  barrierEpoch: Number(barrier.barrierEpoch),
                  spot: Number(barrier.spot),
                  spotEpoch: Number(barrier.spotEpoch),
              },
              barrierDelayMs: 500,
          }
        : undefined;

    // Keep active Accumulator positions visible on the same native chart.
    const positionBarriers = [];
    if (openPosition && openPosition.symbol === symbol && !String(openPosition.status || '').includes('SETTLED')) {
        const entrySpot = Number(openPosition.entrySpot);
        const contractBarrier = Number(openPosition.barrier);
        if (Number.isFinite(entrySpot)) {
            positionBarriers.push({
                high: entrySpot,
                low: entrySpot,
                color: '#f5c451',
                title: 'OPEN ENTRY',
                shade: 'NONE_SINGLE',
                isSingleBarrier: true,
                draggable: false,
                useInlineLabel: true,
            });
        }
        if (Number.isFinite(contractBarrier)) {
            positionBarriers.push({
                high: contractBarrier,
                low: contractBarrier,
                color: '#ef6477',
                title: 'CONTRACT BARRIER',
                shade: 'NONE_SINGLE',
                isSingleBarrier: true,
                draggable: false,
                useInlineLabel: true,
            });
        }
    }

    if (!chartData?.activeSymbols?.length || !symbol || !bridge) {
        return <div className="deriv-smartchart-loading">Connecting Deriv market data…</div>;
    }

    return (
        <div className="deriv-smartchart-shell">
        <SmartChart
            id="trade"
            symbol={symbol}
            chartType="mountain"
            granularity={0}
            isLive
            isMobile={isMobile}
            isConnectionOpened={connectionOpen}
            settings={{
                countdown: false,
                isHighestLowestMarkerEnabled: false,
                language: 'en',
                position: 'bottom',
                theme: 'dark',
                whitespace: 190,
                minimumLeftBars: isMobile ? 3 : undefined,
            }}
            chartData={chartData}
            feedCall={{ activeSymbols: false, tradingTimes: false }}
            getQuotes={request => bridge.getHistory(request)}
            subscribeQuotes={(request, callback) => bridge.subscribe(request.symbol || symbol, callback)}
            unsubscribeQuotes={request => bridge.unsubscribe(request || { symbol, granularity: 0 })}
            accumulatorBarriers={accumulatorBarriers}
            topWidgets={() => <div />}
            chartControlsWidgets={() => (
                <>
                    <CrosshairToggle enabled={true} />
                    <DrawTools />
                    <ChartSetting />
                </>
            )}
            barriers={positionBarriers}
            enabledNavigationWidget={!isMobile}
            enabledChartFooter={false}
            isVerticalScrollEnabled={!isMobile}
            maxTick={isMobile ? 8 : undefined}
            allowTickChartTypeOnly
            should_zoom_out_on_yaxis
            yAxisMargin={{ top: isMobile ? 76 : 106 }}
            shouldFetchTradingTimes={false}
            clearChart={false}
            stateChangeListener={(state, option) => {
                const stateName = typeof state === 'string' ? state : state?.state || state?.status || '';
                const detail = JSON.stringify({ state: stateName, option: option ?? null });
                window.__publishDerivChartDiagnostic?.('chart_state_change', detail);
                if (String(stateName).toUpperCase() === 'READY') {
                    const readyDetail = 'SmartCharts stateChangeListener reports READY';
                    setChartReady(true);
                    setDiagnostic({ stage: 'chart_ready', detail: readyDetail });
                    window.__publishDerivChartDiagnostic?.('chart_ready', readyDetail);
                }
            }}
            chartStatusListener={ready => {
                if (ready) {
                    const detail = 'SmartCharts chartStatusListener reports chart ready';
                    setChartReady(true);
                    setDiagnostic({ stage: 'chart_ready', detail });
                    window.__publishDerivChartDiagnostic?.('chart_ready', detail);
                }
            }}
            onMessage={message => {
                const detail = message?.text || message?.message || message?.error?.message || 'SmartCharts reported a message';
                setDiagnostic({ stage: 'chart_message', detail: String(detail) });
                window.__publishDerivChartDiagnostic?.('chart_message', String(detail));
            }}
        />
        {!chartReady && (
            <div className="deriv-smartchart-diagnostic" role="status" aria-live="polite">
                <strong>{diagnostic.stage.replaceAll('_', ' ')}</strong>
                <span>{diagnostic.detail}</span>
            </div>
        )}
        </div>
    );
}

const rootElement = document.getElementById('derivSmartChartRoot');
if (rootElement) {
    createRoot(rootElement).render(<ChartApp />);
}
