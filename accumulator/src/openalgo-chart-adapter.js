/* OpenAlgo Charts adapter for the Accumulator screen.
 * Deriv remains the market-data and contract source; this file only adapts ticks
 * into OHLC bars and renders contract-specific reference levels.
 */
(async () => {
  "use strict";
  const VERSION = "2.7.2";
  const CDN = "https://cdn.jsdelivr.net/npm/openalgo-charts@" + VERSION + "/dist/openalgo-charts.mjs";
  const root = document.getElementById("nativeChartHost");
  if (!root) return;

  const intervalSeconds = value => Math.max(60, Number(value) * 60 || 3600);
  function toCandles(ticks, seconds) {
    const candles = [];
    for (const tick of ticks || []) {
      const time = Number(tick.time);
      const price = Number(tick.price);
      if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
      const bucket = Math.floor(time / seconds) * seconds;
      const last = candles[candles.length - 1];
      if (!last || last.time !== bucket) {
        candles.push({ time: bucket, open: price, high: price, low: price, close: price });
      } else {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
      }
    }
    return candles;
  }

  try {
    const lib = await import(CDN);
    const { createChart, darkTheme, PriceLine } = lib;
    if (typeof createChart !== "function" || typeof PriceLine !== "function") {
      throw new Error("OpenAlgo Charts did not expose its chart and price-line APIs.");
    }

    const chart = createChart(root, {
      theme: {
        ...darkTheme,
        background: "#080d14",
        text: "#aab7c8",
        gridColor: "#1d2a3b",
        upColor: "#20bd88",
        downColor: "#ee5969"
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos"
    });
    const series = chart.addSeries("candlestick");
    const lines = Object.create(null);
    let lastKey = "";
    let lastCount = 0;
    let lastDataSignature = "";

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
        lines[name] = new PriceLine({ id: "accumulator-" + name, price, ...options });
        chart.addPrimitive(lines[name]);
      } else {
        lines[name].setPrice(price);
        const patch = { ...options }; delete patch.id; lines[name].setOptions(patch);
      }
    }

    const api = {
      ready: true,
      setData(ticks, intervalMinutes, meta = {}) {
        const seconds = intervalSeconds(intervalMinutes);
        const candles = toCandles(ticks, seconds);
        const key = String(meta.symbol || "") + "|" + seconds;
        // Avoid re-submitting identical history on the one-second UI refresh.
        const tail = candles[candles.length - 1];
        const signature = key + "|" + candles.length + "|" + (tail ? [tail.time, tail.open, tail.high, tail.low, tail.close].join(":") : "");
        if (signature !== lastDataSignature) {
          series.setData(candles);
          lastDataSignature = signature;
          lastCount = candles.length;
        }
        if (key !== lastKey) {
          if (candles.length) chart.timeScale.fitContent(Math.min(candles.length, 240));
          lastKey = key;
        }
        return { candleCount: lastCount };
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
        syncLine("entry", Number.isFinite(entry) ? entry : NaN, {
          color: "#48a9ff", lineWidth: 2, lineStyle: "dashed",
          badge: "ENTRY", leftLabel: Number.isFinite(entry) ? entry.toFixed(precision) : "",
          id: "accumulator-entry"
        });
        syncLine("barrier", Number.isFinite(barrier) ? barrier : NaN, {
          color: "#f0a44b", lineWidth: 2, lineStyle: "solid",
          badge: "BARRIER", leftLabel: Number.isFinite(barrier) ? barrier.toFixed(precision) : "",
          id: "accumulator-barrier"
        });
        syncLine("live", Number.isFinite(live) ? live : NaN, {
          color: "#f2f5fa", lineWidth: 1, lineStyle: "dotted",
          badge: "LIVE", leftLabel: Number.isFinite(live) ? live.toFixed(precision) : "",
          id: "accumulator-live"
        });
      },
      state() {
        return { candleCount: lastCount };
      },
      reset() {
        chart.timeScale.fitContent(Math.max(1, lastCount));
      },
      resize() {
        // OpenAlgo observes its container and handles responsive layout itself.
      },
      destroy() {
        chart.destroy();
        lastCount = 0;
        lastDataSignature = "";
      }
    };
    window.__openAlgoAccumulatorChart = api;
    window.dispatchEvent(new CustomEvent("openalgo-accumulator-chart-ready"));
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
