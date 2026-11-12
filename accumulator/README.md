# Accumulator Lab (Stage 1)

A separate Deriv Accumulator foundation app, kept alongside the existing wallet project.

## What is included
- Direct browser WebSocket connection to Deriv for live synthetic-index ticks.
- Market selector, live price, recent tick tape, and a lightweight price chart.
- Optional Deriv API authorization with a **virtual/demo-account-only** gate.
- Accumulator proposal/quote preview for 1%–5% growth rates.
- No contract purchase endpoint, no automated strategy, and no live-account trading.
- API token is held in memory only; it is not written to local storage or sent to this project's server.

## Run locally
Open `index.html` in a browser, connect the market feed, and optionally authorize using a Deriv demo token with proposal permissions.

## Deploy
The repository-root `render.yaml` defines a Render static site rooted at `accumulator`. Render should deploy the `Trading` branch.

## Important limitations
- This first stage does not reproduce Deriv's Stats panel or implement shadow accumulator counting.
- Quote availability and supported proposal fields are determined by Deriv's live API response.
- No order is purchased. The strategy and execution layer will be added only after the market/statistics logic is validated.
- Do not paste a real-account token. This prototype is not a production trading system and has not been security audited.
