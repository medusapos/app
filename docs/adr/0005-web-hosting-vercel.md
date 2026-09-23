# Web app hosting on Vercel

Status: Accepted
Date: 2026-09-23

## Context

The tester MVP needs the Expo web export hosted at `app.medusapos.com`. The
repo's first deploy path was a GitHub Actions workflow calling the Vercel CLI,
which needs a `VERCEL_TOKEN` Actions secret. A Vercel token cannot be minted
from the CLI, and a long-lived token in Actions is one more secret to rotate.

## Decision

- **Team:** the Vercel project `medusapos` lives on the **WCPOS** team
  (`wcpos`, Pro plan), not Paul's personal Hobby team. MedusaPOS is a
  commercial product and Hobby is for non-commercial use.
  Org ID `team_yEMrtaJstckKmEA3FnMnNYCF`, project ID
  `prj_dV8tlEh5AP2Nc0CsZp2F42op3qwX`.
- **Deploy method:** Vercel's GitHub integration. Every push to `main`
  deploys to production; other branches and PRs get preview deployments.
  No Actions secret is involved, and `.github/workflows/deploy.yml` is
  removed so a token can never cause a second, competing deploy.
- **Build definition lives in the repo:** `apps/expo/vercel.json` names the
  install and build commands and the `dist` output. `scripts/vercel-install.sh`
  fetches TallyUI at the pinned commit into the sibling `tallyui` directory
  that the root `pnpm.overrides` expect, then runs
  `pnpm install --frozen-lockfile`. The build runs `expo export` and then
  `scripts/check-web-bundle.sh`, so a leaked secret fails the deployment.
- **Project settings outside the repo:** Root Directory `apps/expo` and
  Node.js 22.x (matching CI). Everything else comes from `vercel.json`.
- **Domain:** `app.medusapos.com` is attached to the project. It goes live
  once the Squarespace DNS for `medusapos.com` has a CNAME `app` pointing to
  Vercel and a `_vercel` TXT record proving ownership to the WCPOS team
  (both still pending on 2026-09-23).

## Consequences

- `TALLYUI_REF` now appears in `.github/workflows/ci.yml` and
  `scripts/vercel-install.sh`; bump both together.
- `vercel.json` does not use `cleanUrls`: with it, Vercel redirects
  `/index.html` to `/` and the SPA fallback rewrite returns 404 on reload.
- Preview deployments sit behind Vercel's deployment protection; testers use
  the production domain only.
- Changing the Root Directory or Node version is a Vercel dashboard change,
  not a PR.
