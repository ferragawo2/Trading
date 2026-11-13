import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SmartChart, setSmartChartsPublicPath } from "@deriv-com/smartcharts-champion";
import "@deriv-com/smartcharts-champion/dist/smartcharts.css";

setSmartChartsPublicPath("/chart-dist/");

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function createDerivTransport() {
  let socket;
  let nextId = 1;
  const pending = new Map();
  const subscriptions = new Map();
  const callbacks = new Map();
  let opening;

  const connect = () => {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      socket = ws;
      const timeout = setTimeout(() => reject(new Error("Deriv chart connection timed out")), 12000);
      ws.onopen = () => { clearTimeout(timeout); opening = null; resolve(ws); };
      ws.onerror = () => { clearTimeout(timeout); opening = null; reject(new Error("Could not connect to Deriv chart feed")); };
      ws.onclose = () => {
        opening = null;
        for (const [id, item] of pending) { item.reject(new Error("Deriv chart connection closed")); pending.delete(id); }
      };
      ws.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const id = message.req_id;
        if (id && pending.has(id)) {
          const item = pending.get(id);
          if (!message.subscription) pending.delete(id);
          if (message.error) item.reject(new Error(message.error.message || "Deriv API error"));
          else item.resolve(message);
        }
        const subId = message.subscription?.id;
        const symbol = message.echo_req?.ticks_history || message.echo_req?.ticks || message.tick?.symbol;
        if (subId && symbol) {
          const key = [...subscriptions.entries()].find(([, value]) => value.subId === subId)?.[0];
          if (key) callbacks.get(key)?.(message);
        } else if (symbol) {
          for (const [key, value] of subscriptions) if (value.symbol === symbol) callbacks.get(key)?.(message);
        }
      };
    });
    return opening;
  };

  const send = async (payload) => {
    const ws = await connect();
    const req_id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(req_id, { resolve, reject });
      ws.send(JSON.stringify({ ...payload, req_id }));
    });
  };

  return {
    send,
    subscribe: async (request, callback) => {
      const key = request.symbol + "|" + (request.granularity || 0);
      callbacks.set(key, callback);
      subscriptions.set(key, { symbol: request.symbol, subId: null });
      const payload = { ticks_history: request.symbol, end: "latest", count: 1, subscribe: 1, style: request.granularity ? "candles" : "ticks" };
      if (request.granularity) payload.granularity = Number(request.granularity);
      const response = await send(payload);
      if (response.subscription?.id) subscriptions.get(key).subId = response.subscription.id;
      return () => {
        const sub = subscriptions.get(key);
        if (sub?.subId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ forget: sub.subId, req_id: nextId++ }));
        subscriptions.delete(key);
        callbacks.delete(key);
      };
    },
    close: () => { try { socket?.close(); } catch {} }
  };
}

const transport = createDerivTransport();

function toActiveSymbol(item) {
  return {
    allow_forward_starting: 0,
    display_name: item.display_name || item.symbol,
    exchange_is_open: item.exchange_is_open ?? 1,
    is_trading_suspended: item.is_trading_suspended ?? 0,
    market: item.market || "synthetic_index",
    market_display_name: item.market_display_name || "Synthetic Indices",
    pip: Math.pow(10, -(Number(item.pip) || 2)),
    submarket: item.submarket || "synthetics",
    submarket_display_name: item.submarket_display_name || "Synthetics",
    symbol: item.symbol,
    symbol_type: item.symbol_type || "stockindex"
  };
}

function ChartApp() {
  const [symbols, setSymbols] = useState([]);
  const [symbol, setSymbol] = useState(new URLSearchParams(location.search).get("symbol") || "R_100");
  const [ready, setReady] = useState(false);
  const liveSymbol = useRef(symbol);

  useEffect(() => {
    liveSymbol.current = symbol;
    window.__derivChartSetSymbol = next => {
      if (next) { liveSymbol.current = next; setSymbol(next); }
    };
    let cancelled = false;
    transport.send({ active_symbols: "brief", contract_type: ["ACCU"] })
      .then(response => {
        if (cancelled) return;
        const list = (response.active_symbols || []).map(toActiveSymbol);
        setSymbols(list);
        if (list.some(item => item.symbol === liveSymbol.current)) setSymbol(liveSymbol.current);
        else if (list.length) setSymbol(list[0].symbol);
        setReady(true);
      })
      .catch(error => { const node = document.getElementById("derivChartStatus"); if (node) node.textContent = error.message; });
    return () => { cancelled = true; delete window.__derivChartSetSymbol; transport.close(); };
  }, []);

  const getQuotes = useCallback(async ({ symbol: requestedSymbol, granularity = 0, count = 1000, start, end, style }) => {
    const request = { ticks_history: requestedSymbol, end: end || "latest", adjust_start_time: 1 };
    if (start) request.start = start; else request.count = count || 1000;
    if (style === "candles" || granularity) { request.style = "candles"; request.granularity = Number(granularity) || 60; }
    else request.style = "ticks";
    const response = await transport.send(request);
    if (response.history) return { history: { times: response.history.times || [], prices: response.history.prices || [] } };
    if (response.candles) return { candles: response.candles };
    return { history: { times: [], prices: [] }, candles: [] };
  }, []);

  const subscribeQuotes = useCallback(({ symbol: requestedSymbol, granularity = 0 }, callback) => {
    let unsubscribe = () => {};
    let cancelled = false;
    transport.subscribe({ symbol: requestedSymbol, granularity }, message => {
      if (cancelled) return;
      if (message.tick) {
        const tick = message.tick;
        callback({ Date: new Date(tick.epoch * 1000).toISOString(), Close: Number(tick.quote), DT: new Date(tick.epoch * 1000), tick });
      } else if (message.candles?.length) callback({ candles: message.candles });
    }).then(fn => { unsubscribe = fn; if (cancelled) fn(); }).catch(error => {
      const node = document.getElementById("derivChartStatus");
      if (node) node.textContent = error.message;
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const unsubscribeQuotes = useCallback(request => {
    const key = request.symbol + "|" + (request.granularity || 0);
    const sub = transport;
    void key; void sub;
  }, []);

  const chartData = useMemo(() => ({
    activeSymbols: symbols,
    tradingTimes: { trading_times: { markets: [] } }
  }), [symbols]);

  return <div className="deriv-smartchart-shell">
    {!ready && <div id="derivChartStatus" className="deriv-chart-status">Connecting to Deriv chart feed…</div>}
    {ready && symbols.length > 0 && <SmartChart
      id="accumulator-deriv-smartchart"
      symbol={symbol}
      chartType="mountain"
      granularity={0}
      getQuotes={getQuotes}
      subscribeQuotes={subscribeQuotes}
      unsubscribeQuotes={unsubscribeQuotes}
      chartData={chartData}
      feedCall={{ activeSymbols: false, tradingTimes: false }}
      isMobile={window.innerWidth < 760}
      isConnectionOpened={true}
      maxTick={500}
      shouldFetchTradingTimes={false}
    />}
    {ready && !symbols.length && <div className="deriv-chart-status">Deriv did not return supported chart symbols.</div>}
  </div>;
}

const mount = document.getElementById("derivSmartChartRoot");
if (mount) createRoot(mount).render(<ChartApp />);
