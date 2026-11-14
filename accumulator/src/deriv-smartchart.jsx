import React from 'react';
import { createRoot } from 'react-dom/client';
import { SmartChart, setSmartChartsPublicPath } from '@deriv-com/smartcharts-champion';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import './deriv-smartchart.css';

setSmartChartsPublicPath('/dist/');

function ChartApp() {
    const bridge = window.__derivChartBridge;
    const [chartState, setChartState] = React.useState(() => window.__derivAccumulatorChartState || {});
    const [chartData, setChartData] = React.useState(() => bridge?.getMetadata?.() || null);
    const [connectionOpen, setConnectionOpen] = React.useState(() => !!bridge?.isConnected?.());
    const isMobile = window.matchMedia('(max-width: 700px)').matches;

    React.useEffect(() => {
        const updateState = event => setChartState(event.detail || {});
        const updateMetadata = event => setChartData(event.detail || null);
        const updateConnection = event => setConnectionOpen(!!event.detail?.connected);

        window.addEventListener('deriv-accumulator-chart-state', updateState);
        window.addEventListener('deriv-chart-metadata', updateMetadata);
        window.addEventListener('deriv-chart-connection', updateConnection);

        window.__derivChartSetSymbol = symbol => setChartState(current => ({ ...current, symbol }));

        return () => {
            window.removeEventListener('deriv-accumulator-chart-state', updateState);
            window.removeEventListener('deriv-chart-metadata', updateMetadata);
            window.removeEventListener('deriv-chart-connection', updateConnection);
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

    if (!chartData?.activeSymbols?.length || !symbol || !bridge) {
        return <div className="deriv-smartchart-loading">Connecting Deriv market data…</div>;
    }

    return (
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
            getQuotes={request => bridge.getHistory(request)}
            subscribeQuotes={(request, callback) => bridge.subscribe(request.symbol || symbol, callback)}
            unsubscribeQuotes={request => bridge.unsubscribe(request || { symbol, granularity: 0 })}
            accumulatorBarriers={accumulatorBarriers}
            topWidgets={() => <div />}
            chartControlsWidgets={null}
            toolbarWidget={() => null}
            enabledNavigationWidget={!isMobile}
            enabledChartFooter={false}
            isVerticalScrollEnabled={!isMobile}
            maxTick={isMobile ? 8 : undefined}
            allowTickChartTypeOnly
            should_zoom_out_on_yaxis
            yAxisMargin={{ top: isMobile ? 76 : 106 }}
            shouldFetchTradingTimes={false}
            clearChart={false}
        />
    );
}

const rootElement = document.getElementById('derivSmartChartRoot');
if (rootElement) {
    createRoot(rootElement).render(<ChartApp />);
}
