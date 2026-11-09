# Trading — Northstar Wallet

A responsive non-custodial multi-chain wallet interface.

## Networks
- EVM: Ethereum, BNB Smart Chain, Polygon, Arbitrum One, Base.
- Bitcoin wallet detection through the UniSat browser extension integration hook.

## Run locally
Open `index.html` in a modern browser or serve this directory with any static web server.

## Security model
- Never requests or stores recovery phrases or private keys.
- EVM transactions are submitted to the user's injected wallet for local signing.
- No custodial backend, account database, or server-side signing.
- Verify recipient, chain, fees, and amount in your wallet before approval.

## Current limitations
- This is a self-custody wallet interface, not an exchange or hosted custody service.
- Native EVM balance display and native-coin transfers are implemented.
- Bitcoin support currently detects UniSat as an integration point; full Bitcoin portfolio and transaction workflows are not yet complete.
- ERC-20 token balances/transfers, transaction indexing, fiat price aggregation, and an independent security audit remain future work.
- Public RPC endpoints may rate-limit or become unavailable.
