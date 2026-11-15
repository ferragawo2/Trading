import React from 'react';
import { createRoot } from 'react-dom/client';
import { SmartChart, setSmartChartsPublicPath, ChartMode, ToolbarWidget, CrosshairToggle, DrawTools, StudyLegend, ChartSetting, ChartSize, Share } from '@deriv-com/smartcharts-champion';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import './deriv-smartchart.css';

setSmartChartsPublicPath('/dist/');

function ChartApp() {
    const bridge = window.__derivChartBridge;
    const [chartState, setChartState] = React.useState(() => window.__derivAccumulatorChartState || {});
    const [chartData, setChartData] = React.useState(() => bridge?.getMetadata?.() || null);
    const [connectionOpen, setConnectionOpen] = React.useState(() => !!bridge?.isConnected?.());
    const [chartReady, setChartReady] = React.useState(false);
    const [positionState, setPositionState] = React.useState(() => window.__derivAccumulatorOpenPosition || { position: null, contractInfo: null, closedBarrier: null });
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
        const updateOpenPosition = event => setPositionState(event.detail || { position: null, contractInfo: null, closedBarrier: null });

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
    const openPosition = positionState.position || null;
    const rawContractInfo = positionState.contractInfo || null;
    // Support both the newer trading API field names and the older proposal_open_contract shape.
    const contractSymbol =
        rawContractInfo?.underlying_symbol ||
        rawContractInfo?.underlying ||
        rawContractInfo?.symbol ||
        openPosition?.symbol ||
        '';
    const contractInfo = rawContractInfo && contractSymbol === symbol ? rawContractInfo : null;
    const hasNumber = value =>
        value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    const barrier = chartState.barrier;
    const hasValidBarrier =
        barrier &&
        Number.isFinite(Number(barrier.high)) &&
        Number.isFinite(Number(barrier.low)) &&
        Number(barrier.high) > Number(barrier.low) &&
        Number.isFinite(Number(barrier.spot)) &&
        Number.isFinite(Number(barrier.spotEpoch)) &&
        Number.isFinite(Number(barrier.barrierEpoch));

    const hasPositionProfit = hasNumber(openPosition?.profit);
    const positionProfit = hasPositionProfit ? Number(openPosition.profit) : undefined;
    const positionBarrierIsValid =
        openPosition &&
        openPosition.symbol === symbol &&
        Number.isFinite(Number(openPosition.highBarrier)) &&
        Number.isFinite(Number(openPosition.lowBarrier)) &&
        Number(openPosition.highBarrier) > Number(openPosition.lowBarrier) &&
        hasNumber(openPosition.currentSpot ?? openPosition.spot) &&
        hasNumber(openPosition.currentSpotTime ?? openPosition.spotEpoch) &&
        hasNumber(openPosition.barrierEpoch);

    // SmartCharts' native Accumulator renderer owns the in-chart P/L and
    // profit/loss colour. Keep the ordinary market quote stream as the chart series.
    const closedBarrier = positionState.closedBarrier || null;
    const accumulatorBarriers = positionBarrierIsValid
        ? {
              live: {
                  highBarrier: String(openPosition.highBarrier),
                  lowBarrier: String(openPosition.lowBarrier),
                  barrierEpoch: Number(openPosition.barrierEpoch),
                  spot: Number(openPosition.currentSpot ?? openPosition.spot),
                  spotEpoch: Number(openPosition.currentSpotTime ?? openPosition.spotEpoch),
                  ...(hasPositionProfit
                      ? {
                            profit: positionProfit,
                            currency: openPosition.currency || '',
                            fractionalDigits: Number.isFinite(Number(openPosition.fractionalDigits))
                                ? Number(openPosition.fractionalDigits)
                                : 2,
                        }
                      : {}),
                  ...(openPosition.isSold ? { isSold: true } : {}),
              },
              ...(closedBarrier ? { closed: closedBarrier } : {}),
              barrierDelayMs: 500,
          }
        : hasValidBarrier
          ? {
                live: {
                    highBarrier: String(barrier.high),
                    lowBarrier: String(barrier.low),
                    barrierEpoch: Number(barrier.barrierEpoch),
                    spot: Number(barrier.spot),
                    spotEpoch: Number(barrier.spotEpoch),
                },
                ...(closedBarrier ? { closed: closedBarrier } : {}),
                barrierDelayMs: 500,
            }
          : closedBarrier
            ? { live: null, closed: closedBarrier }
            : undefined;

    // The same native marker group used by SmartCharts for contract entry:
    // startTime paints the vertical line; entrySpot paints the entry-price dot.
    const entryEpoch = Number(openPosition?.entrySpotTime);
    const entrySpot = Number(openPosition?.entrySpot);
    const currentPositionEpoch = Number(openPosition?.currentSpotTime ?? openPosition?.spotEpoch);
    const positionMarkers =
        positionBarrierIsValid &&
        Number.isFinite(entryEpoch) &&
        Number.isFinite(entrySpot) &&
        Number.isFinite(currentPositionEpoch)
            ? [
                  {
                      type: 'AccumulatorContract',
                      direction: 'up',
                      currentEpoch: currentPositionEpoch,
                      props: {
                          isProfit: !hasPositionProfit || positionProfit >= 0,
                          isRunning: !openPosition.isSold,
                      },
                      markers: [
                          { epoch: entryEpoch, quote: entrySpot, type: 'startTime', direction: 'up' },
                          { epoch: entryEpoch, quote: entrySpot, type: 'entrySpot', direction: 'up' },
                      ],
                  },
              ]
            : [];

    if (!chartData?.activeSymbols?.length || !symbol || !bridge) {
        return <div className="deriv-smartchart-loading">Connecting Deriv market data…</div>;
    }

    return (
        <div className="deriv-smartchart-shell">
        <SmartChart
            id="trade"
            symbol={symbol}
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
            subscribeQuotes={(request, callback) => bridge.subscribe(request, callback)}
            unsubscribeQuotes={request => bridge.unsubscribe(request || { symbol, granularity: 0 })}
            accumulatorBarriers={accumulatorBarriers}
            contractInfo={contractInfo || undefined}
            // Contract ticks are position metadata, not a replacement for the live market series.
            shouldDrawTicksFromContractInfo={false}
            contracts_array={positionMarkers}
            getIndicatorHeightRatio={(chartHeight, indicatorCount) => {
                const count = Math.max(1, Number(indicatorCount) || 1);
                const availableHeight = Math.max(90, chartHeight - 220);
                const height = Math.max(72, Math.min(150, Math.floor(availableHeight / count)));
                return { height, percent: height / Math.max(1, chartHeight) };
            }}
            topWidgets={() => <div />}
            chartControlsWidgets={() => (
                <>
                    <CrosshairToggle enabled={true} />
                    <DrawTools />
                    <StudyLegend />
                    <ChartSetting />
                    <ChartSize />
                    <Share />
                </>
            )}
            toolbarWidget={() => (
                <ToolbarWidget position="bottom">
                    <ChartMode
                        onChartType={chartType => window.__publishDerivChartDiagnostic?.('chart_type_changed', chartType)}
                        onGranularity={granularity => window.__publishDerivChartDiagnostic?.('chart_granularity_changed', granularity)}
                    />
                </ToolbarWidget>
            )}
            enabledNavigationWidget={true}
            enabledChartFooter={false}
            isVerticalScrollEnabled={!isMobile}
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
