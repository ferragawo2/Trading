/* Full OpenAlgo Charts widget for the Accumulator trade screen.
 * Deriv remains the source of live ticks and contract data. OpenAlgo owns the
 * chart UI, studies, drawings, transforms, settings and local chart workspace.
 */
(async () => {
  "use strict";
  const VERSION = "2.7.2";
  const CDN = "https://cdn.jsdelivr.net/npm/openalgo-charts@" + VERSION + "/dist/";
  const root = document.getElementById("nativeChartHost");
  if (!root) return;

  function intervalSeconds(value) {
    const code = String(value || "1h").trim().toLowerCase();
    const match = code.match(/^(\d+)(s|m|h|d|w)$/);
    if (!match) return 3600;
    return Math.max(1, Number(match[1])) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]]);
  }

  function toCandles(ticks, interval) {
    const candles = [];
    const tickMode = String(interval).toUpperCase() === "T1";
    let previousTime = -Infinity;
    for (const tick of ticks || []) {
      const epoch = Number(tick.time), price = Number(tick.price);
      if (!Number.isFinite(epoch) || !Number.isFinite(price)) continue;
      if (tickMode) {
        const time = Math.max(epoch, previousTime + 0.000001);
        previousTime = time;
        candles.push({ time, open: price, high: price, low: price, close: price, volume: 1 });
        continue;
      }
      const seconds = intervalSeconds(interval);
      const bucket = Math.floor(epoch / seconds) * seconds;
      const last = candles[candles.length - 1];
      if (!last || last.time !== bucket) candles.push({ time: bucket, open: price, high: price, low: price, close: price });
      else { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
    }
    return candles;
  }

  try {
    const base = await import(CDN + "openalgo-charts.mjs");
    if (typeof base.registerInterval === "function") base.registerInterval({ code: "T1", bucketing: { mode: "ticks", count: 1 } });
    const indicators = await import(CDN + "openalgo-charts.indicators.mjs");
    const drawings = await import(CDN + "openalgo-charts.draw.mjs");
    // Optional tiers register their chart types, profile tools and GPU renderer.
    await import(CDN + "openalgo-charts.transform.mjs");
    await import(CDN + "openalgo-charts.profile.mjs");
    await import(CDN + "openalgo-charts.webgl.mjs");
    const widgetModule = await import(CDN + "openalgo-charts.widget.mjs");

    if (typeof widgetModule.createWidget !== "function") {
      throw new Error("OpenAlgo Charts widget tier is unavailable.");
    }
    if (typeof indicators.registerBuiltinIndicators === "function") {
      indicators.registerBuiltinIndicators();
    }
    if (typeof drawings.registerBuiltinDrawingTools === "function") {
      drawings.registerBuiltinDrawingTools();
    }

    const widget = widgetModule.createWidget(root, {
      symbol: "R_10",
      exchange: "DERIV",
      interval: "T1",
      intervals: ["T1", "1m", "5m", "15m", "30m", "1h", "4h", "1d"],
      chartType: "line",
      theme: {
        ...base.darkTheme,
        background: "#080d14",
        text: "#aab7c8",
        gridColor: "#1d2a3b",
        upColor: "#20bd88",
        downColor: "#ee5969"
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos",
      mobile: "auto",
      rail: true,
      topbar: true,
      indicators: true,
      statusline: true,
      bottombar: true,
      persist: "deriv-accumulator-trade-tick-line",
      drawingScope: "instrument",
      navigation: { mousePan: "both", defaultVisibleBars: 120 },
      renderer: "auto"
    });

    const chart = widget.chart;
    const lines = Object.create(null);
    let lastKey = "";
    let lastSignature = "";
    let lastCount = 0;
    let lastRawCount = 0;
    let tickRefreshCount = 0;
    let ready = false;
    let pending = null;
    let activeSymbol = "R_10";

    function removeLine(name) {
      if (!lines[name]) return;
      chart.removePrimitive(lines[name]);
      delete lines[name];
    }

    function syncLine(name, price, options) {
      if (!Number.isFinite(price)) {
        removeLine(name);
        return;
      }
      if (!lines[name]) {
        lines[name] = new base.PriceLine({ id: "accumulator-" + name, price, ...options });
        chart.addPrimitive(lines[name]);
      } else {
        lines[name].setPrice(price);
        const patch = { ...options };
        delete patch.id;
        lines[name].setOptions(patch);
      }
    }

    function applyData(ticks, meta = {}) {
      if (activeSymbol && widget.symbol() !== activeSymbol) {
        try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) {
          console.warn("OpenAlgo active market sync:", error);
        }
      }
      const interval = widget.interval();
      const candles = toCandles(ticks, interval);
      const key = String(meta.symbol || activeSymbol) + "|" + interval;
      const tail = candles[candles.length - 1];
      const signature = key + "|" + candles.length + "|" +
        (tail ? [tail.time, tail.open, tail.high, tail.low, tail.close].join(":") : "");
      if (signature !== lastSignature) {
        if (String(interval).toUpperCase() === "T1") {
          const reset = key !== lastKey || !lastCount || ticks.length < lastRawCount || ticks.length > lastRawCount + 1 || (ticks.length === lastRawCount && tickRefreshCount >= 100);
          if (reset) { widget.series.setData(candles); tickRefreshCount = 0; }
          else if (tail) { widget.series.update(tail); tickRefreshCount++; }
          lastRawCount = ticks.length;
        } else if (key !== lastKey || candles.length !== lastCount || !lastCount) {
          widget.series.setData(candles); lastRawCount = ticks.length;
        } else if (tail) { widget.series.update(tail); lastRawCount = ticks.length; }
        lastSignature = signature;
        lastCount = candles.length;
      }
      if (key !== lastKey) {
        if (candles.length) chart.timeScale.fitContent(Math.min(candles.length, 240));
        lastKey = key;
      }
      return { candleCount: lastCount, interval };
    }

    function applyPending() {
      if (!pending || !ready) return;
      const next = pending;
      pending = null;
      applyData(next.ticks, next.meta);
    }

    const api = {
      ready: true,
      widget,
      setData(ticks, _intervalMinutes, meta = {}) {
        if (meta.symbol && meta.symbol !== activeSymbol) {
          activeSymbol = meta.symbol;
          if (ready) {
            try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) {
              console.warn("OpenAlgo symbol sync:", error);
            }
          }
          lastKey = "";
          lastSignature = "";
          lastCount = 0;
          lastRawCount = 0;
          tickRefreshCount = 0;
        }
        if (!ready) {
          pending = { ticks, meta };
          return { candleCount: lastCount };
        }
        return applyData(ticks, meta);
      },
      setOverlay(overlay, meta = {}) {
        if (!overlay) {
          removeLine("entry");
          removeLine("barrier");
          removeLine("live");
          return;
        }
        const precision = Math.max(0, Math.min(8, Number(meta.precision ?? 2)));
        const priceValue = value => value == null || value === "" ? NaN : Number(value);
        const entry = priceValue(overlay.entrySpot);
        const barrier = priceValue(overlay.barrier);
        const live = priceValue(overlay.currentSpot);
        syncLine("entry", entry, {
          color: "#48a9ff", lineWidth: 2, lineStyle: "dashed",
          badge: "ENTRY", leftLabel: Number.isFinite(entry) ? entry.toFixed(precision) : ""
        });
        syncLine("barrier", barrier, {
          color: "#f0a44b", lineWidth: 2, lineStyle: "solid",
          badge: "BARRIER", leftLabel: Number.isFinite(barrier) ? barrier.toFixed(precision) : ""
        });
        syncLine("live", live, {
          color: "#f2f5fa", lineWidth: 1, lineStyle: "dotted",
          badge: "LIVE", leftLabel: Number.isFinite(live) ? live.toFixed(precision) : ""
        });
      },
      state() {
        return { candleCount: lastCount, interval: widget.interval(), symbol: widget.symbol() };
      },
      reset() {
        chart.timeScale.fitContent(Math.max(1, lastCount));
      },
      resize() {
        chart.applySize?.();
      },
      destroy() {
        widget.destroy();
        lastCount = 0;
        lastRawCount = 0;
        tickRefreshCount = 0;
        lastSignature = "";
      }
    };

    window.__openAlgoAccumulatorChart = api;
    window.dispatchEvent(new CustomEvent("openalgo-accumulator-chart-ready"));
    Promise.resolve(widget.ready).then(() => {
      ready = true;
      if (activeSymbol && widget.symbol() !== activeSymbol) {
        try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) {
          console.warn("OpenAlgo restored symbol sync:", error);
        }
      }
      applyPending();
      window.dispatchEvent(new CustomEvent("openalgo-accumulator-chart-restored"));
    }).catch(error => {
      console.warn("OpenAlgo saved chart state could not be restored:", error);
      ready = true;
      applyPending();
    });
  } catch (error) {
    console.error("OpenAlgo chart initialization failed:", error);
    window.__openAlgoChartError = error;
    const status = document.getElementById("nativeChartConnection");
    if (status) status.textContent = "CHART LIBRARY UNAVAILABLE";
    const empty = document.getElementById("nativeChartEmpty");
    if (empty) {
      empty.textContent = "OpenAlgo Charts could not load. Check the network connection and refresh.";
      empty.style.display = "grid";
    }
  }
})();
