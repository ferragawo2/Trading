import React from 'react';
import { createRoot } from 'react-dom/client';
import { SmartChart, setSmartChartsPublicPath } from '@deriv-com/smartcharts-champion';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import '@deriv-com/quill-ui/dist/assets/quill-ui.css';
import './deriv-smartchart.css';

setSmartChartsPublicPath('/dist/');

const WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=12812';

function toQuote(message) {
    if (message.tick) {
        const tick = message.tick;
        const epoch = Number(tick.epoch);
        return {
            Date: new Date(epoch * 1000).toISOString(),
            Close: Number(tick.quote),
            tick,
            DT: new Date(epoch * 1000),
        };
    }
    if (message.ohlc) {
        const ohlc = message.ohlc;
        const epoch = Number(ohlc.open_time);
        return {
            Date: new Date(epoch * 1000).toISOString(),
            Open: Number(ohlc.open),
            High: Number(ohlc.high),
            Low: Number(ohlc.low),
            Close: Number(ohlc.close),
            ohlc,
            DT: new Date(epoch * 1000),
        };
    }
    return null;
}

function simplifyTradingTimes(response) {
    const result = {};
    response?.trading_times?.markets?.forEach(market => {
        market.submarkets?.forEach(submarket => {
            submarket.symbols?.forEach(item => {
                const times = item.times || {};
                const open = times.open || [];
                const close = times.close || [];
                const now = new Date();
                const date = now.toISOString().slice(0, 11);
                const allDay = open.length === 1 && open[0] === '00:00:00' && close[0] === '23:59:59';
                const closed = open.length === 1 && open[0] === '--' && close[0] === '--';
                let isOpen = allDay;
                let openTime = '';
                let closeTime = '';
                if (!allDay && !closed && open.length && close.length) {
                    openTime = date + open[0] + 'Z';
                    closeTime = date + close[0] + 'Z';
                    isOpen = now >= new Date(openTime) && now < new Date(closeTime);
                }
                result[item.symbol] = { isOpen, openTime, closeTime };
            });
        });
    });
    return result;
}

class DerivChartFeed {
    constructor(onStatus, onData) {
        this.socket = null;
        this.reqId = 200000;
        this.pending = new Map();
        this.subscriptions = new Map();
        this.subscriptionsByReq = new Map();
        this.onStatus = onStatus;
        this.onData = onData;
        this.connected = false;
        this.metadata = { activeSymbols: [], tradingTimes: {} };
        this.destroyed = false;
        this.reconnectTimer = null;
        this.connect();
    }

    nextId() {
        this.reqId += 1;
        return this.reqId;
    }

    connect() {
        if (this.destroyed) return;
        try {
            const socket = new WebSocket(WS_URL);
            this.socket = socket;
            socket.onopen = async () => {
                this.connected = true;
                this.onStatus(true);
                try {
                    const [symbols, times] = await Promise.all([
                        this.request({ active_symbols: 'brief' }),
                        this.request({ trading_times: 'today' }),
                    ]);
                    this.metadata = {
                        activeSymbols: Array.isArray(symbols.active_symbols) ? symbols.active_symbols : [],
                        tradingTimes: simplifyTradingTimes(times),
                    };
                    this.onData({ ...this.metadata });
                } catch (error) {
                    console.error('Deriv SmartCharts market metadata:', error);
                }
            };
            socket.onmessage = event => this.handleMessage(event);
            socket.onerror = () => this.onStatus(false);
            socket.onclose = () => {
                this.connected = false;
                this.onStatus(false);
                if (!this.destroyed) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = setTimeout(() => this.connect(), 1800);
                }
            };
        } catch (error) {
            this.onStatus(false);
            if (!this.destroyed) this.reconnectTimer = setTimeout(() => this.connect(), 2500);
        }
    }

    waitForOpen() {
        if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const check = () => {
                if (this.destroyed) return reject(new Error('Chart feed closed'));
                if (this.socket?.readyState === WebSocket.OPEN) return resolve();
                if (Date.now() - started > 12000) return reject(new Error('Deriv chart connection timed out'));
                setTimeout(check, 100);
            };
            check();
        });
    }

    async request(payload) {
        await this.waitForOpen();
        const req_id = this.nextId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(req_id);
                reject(new Error('Deriv chart request timed out'));
            }, 12000);
            this.pending.set(req_id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            this.socket.send(JSON.stringify({ ...payload, req_id }));
        });
    }

    handleMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const pending = this.pending.get(message.req_id);
        if (pending) {
            this.pending.delete(message.req_id);
            if (message.error) pending.reject(new Error(message.error.message || message.error.code || 'Deriv API error'));
            else pending.resolve(message);
        }

        const byReq = this.subscriptionsByReq.get(message.req_id);
        if (byReq && message.subscription?.id) {
            byReq.subscriptionId = message.subscription.id;
            this.subscriptions.set(message.subscription.id, byReq);
            this.subscriptionsByReq.delete(message.req_id);
            if (byReq.cancelled) this.forgetSubscription(byReq);
        }
        const subscriptionId = message.subscription?.id;
        const subscription = subscriptionId ? this.subscriptions.get(subscriptionId) : null;
        if (subscription && (message.tick || message.ohlc)) {
            const quote = toQuote(message);
            if (quote) subscription.callback(quote);
        }
    }

    async getQuotes({ symbol, granularity, count, start, end, style }) {
        const request = {
            ticks_history: symbol,
            style: style || (granularity ? 'candles' : 'ticks'),
            count: Math.max(1, Number(count) || 500),
            end: end ? String(end) : 'latest',
            adjust_start_time: 1,
        };
        if (granularity) request.granularity = granularity;
        if (start) request.start = String(start);
        const response = await this.request(request);
        if (Array.isArray(response.candles)) {
            return {
                candles: response.candles.map(candle => ({
                    open: Number(candle.open),
                    high: Number(candle.high),
                    low: Number(candle.low),
                    close: Number(candle.close),
                    epoch: Number(candle.epoch),
                })),
            };
        }
        if (response.history?.prices && response.history?.times) {
            return {
                history: {
                    prices: response.history.prices.map(Number),
                    times: response.history.times.map(Number),
                },
            };
        }
        return {};
    }

    subscribeQuotes({ symbol, granularity, style }, callback) {
        const subscription = {
            symbol,
            granularity: granularity || 0,
            callback,
            subscriptionId: null,
            cancelled: false,
        };
        const req_id = this.nextId();
        this.subscriptionsByReq.set(req_id, subscription);
        this.waitForOpen().then(() => {
            if (subscription.cancelled) return;
            const request = {
                ticks_history: symbol,
                style: style || (granularity ? 'candles' : 'ticks'),
                subscribe: 1,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                req_id,
            };
            if (granularity) request.granularity = granularity;
            this.socket.send(JSON.stringify(request));
        }).catch(error => console.error('Deriv chart subscription:', error));

        return () => {
            subscription.cancelled = true;
            this.subscriptionsByReq.delete(req_id);
            if (subscription.subscriptionId) this.forgetSubscription(subscription);
        };
    }

    forgetSubscription(subscription) {
        const id = subscription.subscriptionId;
        if (!id) return;
        this.subscriptions.delete(id);
        subscription.subscriptionId = null;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ forget: id, req_id: this.nextId() }));
        }
    }

    unsubscribeQuotes(request) {
        const symbol = request?.symbol || request?.ticks_history;
        const granularity = Number(request?.granularity || 0);
        for (const subscription of this.subscriptions.values()) {
            if ((!symbol || subscription.symbol === symbol) && subscription.granularity === granularity) {
                this.forgetSubscription(subscription);
            }
        }
    }

    destroy() {
        this.destroyed = true;
        clearTimeout(this.reconnectTimer);
        this.pending.forEach(item => item.reject(new Error('Chart feed closed')));
        this.pending.clear();
        this.subscriptions.clear();
        this.subscriptionsByReq.clear();
        try { this.socket?.close(); } catch {}
    }
}

function ChartApp() {
    const [chartState, setChartState] = React.useState(() => window.__derivAccumulatorChartState || {});
    const [connected, setConnected] = React.useState(false);
    const [chartData, setChartData] = React.useState(null);
    const [feed] = React.useState(() => new DerivChartFeed(setConnected, setChartData));

    React.useEffect(() => {
        const update = event => setChartState(event.detail || {});
        window.addEventListener('deriv-accumulator-chart-state', update);
        window.__derivChartSetSymbol = symbol => {
            setChartState(current => ({ ...current, symbol }));
        };
        return () => {
            window.removeEventListener('deriv-accumulator-chart-state', update);
            delete window.__derivChartSetSymbol;
            feed.destroy();
        };
    }, [feed]);

    const symbol = chartState.symbol || '';
    const barrier = chartState.barrier;
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

    if (!chartData || !symbol) {
        return <div className="deriv-smartchart-loading">{connected ? 'Loading Deriv chart…' : 'Connecting to Deriv chart…'}</div>;
    }

    return (
        <SmartChart
            id="deriv-accumulator-live"
            symbol={symbol}
            chartType="mountain"
            granularity={0}
            isLive
            isMobile={window.matchMedia('(max-width: 700px)').matches}
            isConnectionOpened={connected}
            settings={{ theme: 'dark', lang: 'en', position: 'bottom', enabledNavigationWidget: false }}
            chartData={chartData}
            feedCall={{ activeSymbols: false, tradingTimes: false }}
            getQuotes={request => feed.getQuotes(request)}
            subscribeQuotes={(request, callback) => feed.subscribeQuotes(request, callback)}
            unsubscribeQuotes={request => feed.unsubscribeQuotes(request)}
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
