# ChainHilt wallet

MCP wallet for authorizing ChainHilt API requests, signing verified actions, and sending transactions. API payments use a separate x402 client such as AgentCash.

## Install and set up

```sh
npx -y chainhilt@latest init           # register the MCP with detected agent clients
npx -y chainhilt@latest doctor         # check registration and connectivity
npx -y chainhilt@latest wallet setup   # create or import a wallet, then show receive details
```

Run any command with `--help` for its options, such as choosing clients or the receive network.

`init` merges a ChainHilt entry into each client's configuration and installs the agent skill, leaving unrelated settings untouched. It pins the package version it ran from; rerun `init` to upgrade. Malformed configuration is rejected rather than overwritten, and a backup of the previous file is only left behind if a write fails. Nothing else, such as an agent application or Node runtime, is installed.

`wallet setup` opens a short-lived private page on this machine for importing a key or creating a wallet. A new key's backup is shown once on that page. Never paste a key into chat. On a remote or headless machine, forward the printed local port, use `--no-open` to copy the link yourself, or use `--terminal` for interactive terminal setup. Closing the page does not delete the saved wallet.

### Agents

Agents installing the wallet on a user's behalf should run it non-interactively and name the client they run in. `--help` lists every supported name, for example `claude-code`, `cursor`, `vscode`, `gemini-cli` or `opencode`:

```sh
npx -y chainhilt@latest init --client claude-code --json     # register the MCP and install the skill
npx -y chainhilt@latest doctor --client claude-code --json   # confirm registration and connectivity
```

Non-interactive `init` requires `--client` or `--all` and never opens wallet setup. For any client not listed, `--client manual` prints the MCP config and steps to add it by hand instead of writing a file. Its output gives each client's reload step; ask the user to do it, since the new tools only appear in a fresh session. Then call `mcp_status`, and if no wallet exists, call `wallet_setup` and give the user the link to open themselves. Never ask for, accept or relay a private key in chat.

## Chains

The wallet signs and sends on every EVM chain the API's bridge providers can start from (56 mainnets), plus Base Sepolia and HyperEVM testnet; `mcp_status` lists them. Each chain uses a public RPC unless `RPC_URL_<chainId>` sets one. Public RPCs can lag, so set your own for chains you use regularly.

## Action verification

Actions returned by any other service, or relayed from another request, are refused. Authorizations and executed actions are kept in memory, so after a restart the actions must be requested again. `API_BASE_URL` must use https, except for localhost.

## Wallet storage

The private key is kept in the OS keychain: the macOS login keychain, Windows Credential Manager, or a Secret Service such as GNOME Keyring on Linux. `~/.chainhilt/wallet.json` (`CHAINHILT_HOME` changes the directory) holds only the address, so status and receive details never read the keychain. On macOS, programs from the same developer as the one that stored the key, such as any official Node.js, read it without asking; others, such as Claude Desktop, show a keychain prompt first, and denying it fails the request without signing.

Without a keychain, as on most headless Linux machines and containers, the key is kept in plain text in `~/.chainhilt/wallet.key`, readable only by the current OS user. `CHAINHILT_KEY_STORAGE=file` chooses the file explicitly. `mcp_status` and `doctor` report the storage as `keyStorage`, with a warning for a plain file or a `WALLET_PRIVATE_KEY` key. A `wallet.key` from an earlier version moves into the keychain the next time the MCP starts, and is deleted once the keychain returns it intact.

No MCP tool or command output contains the key, apart from a new key's one-time backup. Installation, diagnosis and MCP startup never generate a key, and an existing wallet is never replaced.

The keychain keeps the key out of files, backups and synced folders, but not away from other programs, including an agent with shell access: on Windows and Linux anything running as the same user can read it, and on macOS so can scripts run by official Node.js and, once Claude Desktop is always allowed, its other extensions.

## Funding

The receive page shows the selected network, asset, address and QR code for a manual transfer from another wallet, and checks the balance for a while after it opens; refresh manually after that. Deposit both the assets an operation needs and native gas for its network. The x402 client's payment balance is separate. Managed funding and on/off-ramps are not part of this package yet.

## Tools and execution

- `mcp_status`: configuration, wallet address and key storage; works without a wallet.
- `wallet_setup`: opens the private setup/receive page; never takes or returns keys.
- `wallet_balance`: native or ERC-20 balance for the wallet or another address.
- `get_chain_info`: supported chains and tokens.
- `authorize_request`: authorize the exact method, URL and JSON body of an API request.
- `process_action`: execute the verified actions an authorized request returned.

Send the header returned by `authorize_request` with the API request through the payment client. Before signing, the wallet checks that each action was stamped by the API for this wallet's request and has not expired or already run, and it verifies the whole batch before executing any of it. A stamp proves where an action came from, not that it matches the user's intent, so agents should still check amounts, recipients and prices against the user's request.

Authorization and execution state lives in the MCP process. After a restart or expiry, request a fresh authorization and new actions, and check transaction or order status before repeating an operation that may already have been submitted. A wallet created through setup is picked up by the running MCP without a restart.

## Configuration

Defaults target the production ChainHilt API on Base. Environment variables can override the wallet directory, key storage, API URL, active chain, RPC endpoints and the key itself; see `src/config.ts` and `src/chains.ts` for the current list. A non-local API URL must use HTTPS. Client configuration paths follow each client's own location overrides.

## Local development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js init --local --skip-setup
```

`--local` registers the compiled CLI with the current Node executable, which is useful before publication. Use an isolated home or client config directory when testing installation. A package-local `.env` is loaded when present for development, but wallet state is never written there.

`pnpm build:mcpb` builds a Claude Desktop extension bundle with the same server and setup page, and `pnpm test:artifacts` smoke-tests the built outputs.
