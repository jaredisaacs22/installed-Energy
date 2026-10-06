# Access control

## What the site does today

On first visit the site asks for a work email and only continues if the address ends in exactly `@sunbeltrentals.com`. Matching is case-insensitive, and subdomains and lookalike domains are rejected. The session is remembered in that browser for 30 days, and **Sign out** clears it. To change the allowed domains, edit `ALLOWED_DOMAINS` in `assets/js/access.js`.

## What it does not do

GitHub Pages serves static files, so this check runs in the visitor's browser:

- It **does not verify** that the person owns the address; anyone can type any `@sunbeltrentals.com` address.
- The JSON files under `data/` (public programs and tariffs research) remain downloadable by URL. If the repository is public, the source is visible on GitHub too.
- The Workbench page (`assets/workbench/workbench.html`) is a static file like any other under `assets/`, so it is reachable by URL without signing in. That is why its embedded fonts and unit prices were removed before it was committed ([WORKBENCH.md](WORKBENCH.md)). Do not add prices, customer data or licensed files under `assets/` or `data/`.
- **Site inputs and portfolios never leave the visitor's browser** (they live in `localStorage`), so customer site data is not exposed by the hosting.

Treat the gate as a "keep casual visitors out" measure, not security.

## Enforcing real email-based access

If the site needs to be truly restricted to company staff, put it behind an identity-aware proxy that verifies the email before serving any file:

- **Cloudflare Access (Zero Trust).** Point a custom domain for the Pages site through Cloudflare, create an Access application for it, and add a policy allowing *emails ending in* `@sunbeltrentals.com`. Users get a one-time PIN by email (or your SSO). Cloudflare's free Zero Trust tier covers small teams. Keep the in-app gate as a second layer.
- **Company SSO.** If Sunbelt Rentals uses Okta, Microsoft Entra ID or similar, IT can front the site with the same proxy using SSO instead of email PINs.
- **GitHub Enterprise Cloud private Pages.** Organizations on Enterprise Cloud can publish Pages visible only to organization members.

Each of these is set up by an account or IT administrator; no code change is needed here.
