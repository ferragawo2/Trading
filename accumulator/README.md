# Deriv Accumulator Lab

A browser-based Deriv Accumulator app with live synthetic-index data, native Deriv Accumulator proposal statistics, manual trading and an optional stat-matching Algo engine.

## Existing app services reused by the Algo engine

- The public Deriv WebSocket already used by the app supplies live market updates and the ticks_stayed_in Accumulator statistics for each supported growth rate.
- The existing OAuth session and account-scoped Deriv WebSocket supply the selected account's balance, authorized proposals, buy requests, contract updates and early sells.
- The Algo engine reuses those connections and the app's existing account selection. It does not create a second login flow, duplicate market feed or backend token store.
- Deriv authentication/session material stays in the app's existing session handling. Algo recovery storage contains contract identifiers and trade metadata only, not access tokens.

## Stat-matching strategy

Each growth-rate tracker learns independently from completed Deriv counting runs:

1. A completed run becomes a Watch Stat only when its value is greater than 15 and less than 45 (16–44).
2. The tracker waits for a later run to approach that same value.
3. It prepares an account-specific quote before the matching count and arms at Watch Stat minus one.
4. A buy is sent only while the live count is still exactly one below the Watch Stat. If the run cuts before an unsent entry, the arm is cancelled. A submitted buy cannot be cancelled locally, so any late fill after a cut is immediately managed for early closure when Deriv marks it sellable.
5. Once Deriv confirms the contract, the tracker counts two distinct post-entry contract updates and sends a market sell only when is_valid_to_sell is true. If the contract settles naturally first, its live subscription confirms settlement.
6. After settlement, the tracker waits for the current counting run to finish before learning its next Watch Stat.

Normal mode runs independent 1%, 2%, 3% and 4% trackers. Aggressive mode adds an independent 5% tracker. The configured stake is per contract; the start check requires balance for the maximum simultaneous stake exposure of four or five contracts respectively.

## Safety and limitations

- Demo trading is the recommended first validation environment. Real-account Algo start requires a separate confirmation and can lose the full stake on each contract.
- “Stop New Entries” prevents new signals from being sent but continues monitoring buys already submitted and contracts already open.
- Account switching is blocked while Algo orders or positions are still active. Confirmed open contract IDs and unacknowledged buy intents are saved locally so the app can resume monitoring after a page refresh.
- A submitted buy request cannot be cancelled by the client. If its acknowledgement is lost, the app checks the authenticated Deriv account statement and follows a matching contract with proposal_open_contract. Ambiguous matches remain blocked for manual review; the bot never repeats an uncertain buy.
- This software is not audited, does not guarantee execution at a specific tick, and is not investment advice. Quotes, network latency, Deriv sellability and market settlement can affect actual outcomes. Use the demo account to test behaviour before considering real funds.

## Build and tests

From the accumulator directory:

    npm install
    npm test
    npm run build

The Render build runs the strategy tests before bundling the Deriv SmartCharts entry point.
