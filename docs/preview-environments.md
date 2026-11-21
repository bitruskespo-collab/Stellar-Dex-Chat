# Preview environments

Ephemeral preview environments let reviewers inspect high-risk frontend changes
in an isolated, non-production context before they merge.

## How it works

A preview environment is provisioned automatically for every pull request that
touches files under `Dechat/dex_with_fiat_frontend/` or is labelled `preview`.
It is torn down automatically when the PR is closed or merged, or after
`PREVIEW_TTL_DAYS` days (default: 3) without a new push.

```
PR opened / push ──► preview-deploy.yml ──► Vercel (preview project)
                                        ──► PR comment (URL + revision)
                                        ──► GitHub Deployment record
                                        ──► preview-deployed label

PR closed / merged ──► preview-teardown.yml ──► Vercel deployment removed
                                            ──► GitHub Deployment → inactive
                                            ──► preview-deployed label removed
                                            ──► PR comment updated

Daily cron ──► preview-teardown.yml (expiry sweep)
           ──► Removes previews for PRs idle > PREVIEW_TTL_DAYS days
```

## Safety properties

Preview environments are designed to be safe by construction:

| Property | Mechanism |
| -------- | --------- |
| No real payment credentials | `PAYSTACK_SECRET_KEY` is set to a synthetic stub |
| No production contract | Builds target the Stellar **testnet** RPC and contract address |
| Financial flows disabled | `CAPABILITY_WITHDRAWALS_ENABLED=false` and `CAPABILITY_PAYOUTS_API_ENABLED=false` are forced at build time |
| No real user data | All accounts and transaction data come from `fixtures/preview/preview-env.json` and `fixtures/events/golden_events.json` — fabricated testnet addresses only |
| Isolated Vercel project | Previews deploy to a **separate** Vercel project (`VERCEL_PROJECT_ID_PREVIEW`) with no access to production secrets or databases |
| Secrets never in comments | The PR bot comment and job summary never contain secret values |

## Setup

Three repository secrets are required. All three must be scoped to the
**preview** Vercel project — not the production project.

| Secret | Description |
| ------ | ----------- |
| `VERCEL_TOKEN` | Vercel personal access token with deploy access to the preview project |
| `VERCEL_ORG_ID` | Your Vercel team or personal account ID |
| `VERCEL_PROJECT_ID_PREVIEW` | The Vercel project ID for preview deployments (create a separate project for this) |

### Creating the preview Vercel project

1. In the Vercel dashboard, create a new project linked to this repository.
2. Set the **root directory** to `Dechat/dex_with_fiat_frontend`.
3. Do **not** connect this project to a production domain or add real secrets.
4. Copy the project ID from **Settings → General** and add it as the
   `VERCEL_PROJECT_ID_PREVIEW` repository secret.

### Optional secrets

| Secret | Default | Description |
| ------ | ------- | ----------- |
| `PREVIEW_STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Override RPC endpoint for preview builds |
| `PREVIEW_CONTRACT_ID` | Testnet fixture value | Override contract address for preview builds |
| `PREVIEW_XLM_SAC_ID` | Testnet fixture value | Override SAC address for preview builds |

## Triggering a preview manually

Add the `preview` label to any open PR. The `preview-deploy.yml` workflow
will fire immediately regardless of which files the PR touches.

## Viewing the preview URL

After the workflow completes the bot posts a comment on the PR:

```
## 🔍 Preview environment

URL: https://your-pr-preview.vercel.app

| Field          | Value                                |
| -------------- | ------------------------------------ |
| Revision       | `a1b2c3d4`                          |
| Deployed at    | 2026-11-21T10:00:00Z                |
| Expires        | 3 days after last push               |
| Network        | Stellar testnet (non-production)     |
| Financial flows| Disabled — CAPABILITY_WITHDRAWALS_ENABLED=false |
```

The URL is also visible in the PR's **Deployments** panel (linked to the
GitHub Deployment record created by the workflow).

## Expiry and teardown

| Trigger | Action |
| ------- | ------ |
| PR closed or merged | Immediate teardown via `preview-teardown.yml` |
| No push for `PREVIEW_TTL_DAYS` days | Daily cron sweep removes the deployment |
| `workflow_dispatch` with PR number | Manual teardown |

To change the TTL, update the `PREVIEW_TTL_DAYS` env var in both
`.github/workflows/preview-deploy.yml` and `.github/workflows/preview-teardown.yml`.

## Synthetic data

Preview environments use only the synthetic data in:

- `Dechat/dex_with_fiat_frontend/fixtures/preview/preview-env.json` — env
  configuration, synthetic Stellar addresses, and API stubs.
- `Dechat/dex_with_fiat_frontend/fixtures/events/golden_events.json` — contract
  event fixtures with fabricated testnet addresses.

No real user data, wallet keys, or payment credentials may be added to either
file. See [SECURITY.md](../SECURITY.md) for the credential handling policy.

## Workflow files

| File | Purpose |
| ---- | ------- |
| `.github/workflows/preview-deploy.yml` | Builds and deploys the preview on PR open/push/label |
| `.github/workflows/preview-teardown.yml` | Removes the preview on PR close and via daily expiry sweep |
