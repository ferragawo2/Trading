import React from 'react';
import { createRoot } from 'react-dom/client';
import { SmartChart, setSmartChartsPublicPath } from '@deriv-com/smartcharts-champion';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import './deriv-smartchart.css';

setSmartChartsPublicPath('/dist/');

function ChartApp() {
    const [chartState, setChartState] = React.useState(() => window.__derivAccumulatorChartState || {});
    const [chartData, setChartData] = React.useState(() => window.__derivChartBridge?.getMetadata?.() || null);

    React.useEffect(() => {
        const updateState = event => setChartState(event.detail || {});
        const updateMetadata = event => setChartData(event.detail || null);
        window.addEventListener('deriv-accumulator-chart-state', updateState);
        window.addEventListener('deriv-chart-metadata', updateMetadata);
        window.__derivChartSetSymbol = symbol => setChartState(current => ({ ...current, symbol }));
        return () => {
            window.removeEventListener('deriv-accumulator-chart-state', updateState);
            window.removeEventListener('deriv-chart-metadata', updateMetadata);
            delete window.__derivChartSetSymbol;
        };
    }, []);

    const symbol = chartState.symbol || '';
    const barrier = chartState.barrier;
    const bridge = window.__derivChartBridge;
    const accumulatorBarriers = barrier ? {
        live: {
            highBarrier: String(barrier.high),
            lowBarrier: String(barrier.low),
            barrierEpoch: Number(barrier.barrierEpoch),
            spot: Number(barrier.spot),
            spotEpoch: Number(barrier.spotEpoch),
        },
        barrierDelayMs: 250,
    } : null;

    if (!chartData || !symbol || !bridge) {
        return <div className="deriv-smartchart-loading">Waiting for the app's Deriv market feed…</div>;
    }

    return (
        <SmartChart
            id="deriv-accumulator-live"
            symbol={symbol}
            chartType="mountain"
            granularity={0}
            isLive
            isMobile={window.matchMedia('(max-width: 700px)').matches}
            isConnectionOpened
            settings={{ theme: 'dark', lang: 'en', position: 'bottom', enabledNavigationWidget: false }}
            chartData={chartData}
            feedCall={{ activeSymbols: false, tradingTimes: false }}
            getQuotes={request => bridge.getHistory(request.symbol || symbol, request.count)}
            subscribeQuotes={(request, callback) => bridge.subscribe(request.symbol || symbol, callback)}
            unsubscribeQuotes={() => {}}
            accumulatorBarriers={accumulatorBarriers}
            topWidgets={() => null}
            chartControlsWidgets={() => null}
            toolbarWidget={() => null}
            isVerticalScrollEnabled
            enabledChartFooter={false}
        />
    );
}

const rootElement = document.getElementById('derivSmartChartRoot');
if (rootElement) createRoot(rootElement).render(<ChartApp />);
