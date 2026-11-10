# Trading — Northstar Wallet

A responsive, browser-based non-custodial wallet for selected EVM networks.

## Wallet creation and access
- Create a new EVM wallet in the browser using ethers.js and a cryptographically secure random wallet generator.
- Display the recovery phrase during creation and require the user to confirm that it has been backed up.
- Encrypt the wallet JSON with the user's password before saving it in this browser's local storage.
- Unlock the encrypted wallet on the same browser/device with the password.
- Alternatively, connect an existing EIP-1193 wallet such as MetaMask, Rabby, or Coinbase Wallet.

**Important:** The recovery phrase is the ultimate backup. If it is lost, the password or encrypted browser vault cannot recover the funds. Anyone who obtains the phrase can control the wallet. Do not share it, photograph it, or enter it into a website or chat. Clearing browser storage or changing devices removes the local encrypted vault unless it has been backed up separately.

## Networks
- 39 built-in EVM mainnets, including Ethereum, BNB Smart Chain, Polygon, Arbitrum One, Base, Optimism, Avalanche, Gnosis, Linea, zkSync Era, Scroll, Mantle, Blast, opBNB, Celo, Sonic, Cronos, Moonbeam, Moonriver, Aurora, Harmony, Kava, Metis, Telos, Rootstock, Taiko, Zora, Berachain, Unichain, World Chain, Ink, Abstract, HyperEVM, Sei, Flare, Ethereum Classic, XDC, IoTeX, and Oasis Sapphire.
- Add custom EVM networks using an HTTPS RPC endpoint. The wallet checks that the endpoint reports the supplied chain ID before saving the network locally in this browser.
- When using an injected EIP-1193 wallet, the app requests the selected network be switched or added to that wallet. Your wallet extension may show a confirmation prompt.
- Bitcoin: UniSat detection hook only; full Bitcoin wallet creation, balance, and send/receive are not implemented.

## Run locally
Serve this directory with a static web server and open `index.html` in a modern browser. A browser wallet is needed for the external-wallet connection path. Wallet creation uses the pinned ethers.js browser library from jsDelivr.

## Security model and limitations
- Locally created wallets are encrypted in browser local storage; there is no server-side wallet database or key custody.
- Password encryption does not protect against malware, malicious browser extensions, compromised devices, or malicious code delivered to the page.
- External-wallet transactions are signed by the connected wallet. Locally created-wallet transactions are signed in the browser and broadcast through public RPC endpoints.
- LI.FI-powered token discovery lists supported tokens per EVM network, with searchable token metadata and ERC-20 balances for the first 60 listed assets when connected.
- LI.FI swap quotes support same-chain swaps and cross-chain routes. ERC-20 approvals and the source transaction are submitted only after the user confirms in their wallet. Cross-chain settlement may remain pending after the source transaction confirms; verify LI.FI route status before assuming destination funds arrived.
- Native EVM coin transfers are supported. ERC-20 transfers, full transaction indexing, fiat portfolio pricing, and full Bitcoin workflows are not yet implemented.
- Public RPC endpoints may rate-limit, be unavailable, or return delayed data.
- This MVP has not undergone an independent security audit. Do not use it to store significant funds until the code, dependencies, deployment, and transaction flows have been independently reviewed and audited.


## Swaps and token discovery
- Select **Swap** to request live LI.FI quotes between tokens on supported EVM networks. The wallet must be connected/unlocked and on the source network before execution.
- LI.FI's live token registry populates the selected network's searchable token directory and swap token selectors; token listings vary by chain and provider availability.
- Quotes are indicative until execution. Review the route and wallet transaction details, and independently verify approvals, recipient, network, fees, and token contract addresses before signing.
- The current implementation executes the LI.FI quote's source transaction and displays route status. It does not yet provide a full transaction-history index or automatic recovery for failed destination legs.
