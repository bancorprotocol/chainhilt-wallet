---
name: chainhilt
description: Install and configure ChainHilt's local signing wallet, show its receive address and QR code, and execute verified on-chain actions returned by ChainHilt's x402 API.
---

# ChainHilt wallet

ChainHilt's API builds unsigned on-chain actions; this local wallet MCP signs and submits them.

- Read `/skills.md` on the ChainHilt origin (`mcp_status` shows the configured API) for the current workflow and endpoints before acting.
- Use the wallet tools for anything that needs a signature or transaction: `mcp_status`, `wallet_setup`, `wallet_balance`, `authorize_request` and `process_action`. If they are missing, install the wallet with `npx -y chainhilt@latest init`.
- Never ask for, accept or pass a private key in chat, tool arguments or commands. Send the user to `wallet_setup`, which opens a private page on their machine.
- Tell the user about any `warning` or `notice` in `mcp_status`. Never read files under `~/.chainhilt`; key backups are for the user to make.
- The x402 payment client (such as AgentCash) and this signing wallet are separate and funded separately.
