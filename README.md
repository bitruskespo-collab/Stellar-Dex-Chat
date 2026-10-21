# Stellar-Dex-Chat

A decentralized exchange (DEX) interface prioritizing seamless asset-to-bank conversions leveraging AI-assisted conversations and automated Soroban smart contracts on the Stellar network.

## Overview

Stellar-Dex-Chat connects natural AI conversation flows with Stellar's fast blockchain technology to create an intuitive platform for cryptocurrency to fiat conversions. Users interact with an AI assistant that securely triggers smart contract interactions (utilizing Soroban) directly from the chat UI.

## Project Structure

```
Stellar-Dex-Chat/
├── Dechat/                    # Main application directory
│   ├── stellar-contracts/     # Soroban smart contracts (Rust)
│   ├── dex_with_fiat_frontend/ # Next.js 15 frontend application
│   └── README.md              # Detailed setup and architecture docs
├── docs/                      # Additional documentation
└── scripts/                   # Helper scripts
```

## Quick Start

For detailed installation instructions, architecture overview, and development setup, see the main documentation in [Dechat/README.md](Dechat/README.md).

### Prerequisites

- Node.js (v18 or higher)
- pnpm
- Rust & Cargo tooling with `wasm32-unknown-unknown` target
- Stellar CLI (for interacting with Soroban)
- Docker & Docker Compose (optional, for quick start).

### Fastest Start (Docker)

```bash
git clone https://github.com/leojay-net/Stellar-Dex-Chat.git
cd Stellar-Dex-Chat
cp .env.docker Dechat/dex_with_fiat_frontend/.env.local
docker compose up
```

The services will be available at:
- Frontend: http://localhost:3000
- Soroban RPC: http://localhost:8000/soroban/rpc
- Horizon API: http://localhost:8000

## Documentation

- [Main README](Dechat/README.md) - Complete setup guide, architecture, and development instructions
- [Slippage Threshold](docs/slippage-threshold.md) - How slippage BPS and on-chain threshold interact
- [TypeScript SDK Examples](docs/typescript-sdk-examples.md) - Guide for calling contract functions

## Contributing

Contributions and feature reviews are welcome. Please open an issue to raise bugs or feature requests!

See [Dechat/README.md](Dechat/README.md#contributing) for repository conventions and PR guidelines.

## License

MIT

## Handsoff notes

<!-- handsoff-issue-120 -->
- #120: feat(observability): add PII-redacted structured payout lifecycle logs

<!-- handsoff-issue-13 -->
- #13: feat(contract): reserve withdrawal amounts when requests are queued
