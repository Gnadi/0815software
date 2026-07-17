# 0815software — Site Analysis, Feature Ideas & Valuation

*Analysis of https://0815software.vercel.app/ and this repository, July 2026.*

## What the site is

A dark, "DIN-spec datasheet"-styled marketing site for 0815software: standard business
software (CRUD apps, dashboards, storefronts, internal tools) built in 2–6 weeks,
MIT-licensed and free — revenue comes from paid implementation, customisation, training,
and SLAs. "0815" is German slang for "run-of-the-mill," reclaimed as a compliment.

**Stack:** Astro 6 (static + one serverless endpoint), Tailwind v4 design tokens, Vercel,
Resend contact form, client-side EN/DE i18n. Landing page with 7 sections plus ~19
subpages (module catalogue, roadmap, persona pages, legal).

**Quality impression:** clean, consistent code; semantic HTML; scoped component CSS;
strong copywriting. A solid v1.

## Improvements (prioritized)

### 1. Legal / GDPR — blocking for the DACH market
- ~~No privacy policy page~~ → **fixed:** `/privacy` added.
- ~~Google Fonts loaded from Google's CDN~~ (GDPR violation per LG München 2022) →
  **fixed:** fonts self-hosted via Fontsource.
- ~~German-format placeholder VAT (`DE 0815 0815 15`) for an Austrian company~~ →
  **fixed:** Austrian format placeholder. Replace with the real ATU number before launch.

### 2. Credibility gaps that undercut "full transparency"
- ~~Hero linked to a nonexistent `github.com/0815software` org while the footer linked to
  `github.com/Gnadi/0815software`~~ → **fixed:** unified.
- ~~Pricing contradiction: "€0 to build" (Pillars) vs. "fixed-price quote" (Contact)~~ →
  **fixed:** copy now says the *license* is €0 and commissioned work is paid; spec card
  row renamed `PRICE` → `LICENSE FEE`.
- Case studies / status / changelog contain illustrative content — label as samples or
  make them real. The "read the source" promise needs real module repos behind it.

### 3. SEO / i18n architecture
- ~~No OG/Twitter meta, canonical, sitemap, robots.txt, JSON-LD, or 404 page~~ →
  **fixed:** all added.
- **Still open (bigger refactor):** German content only exists after JavaScript runs
  (client-side text swap), so search engines never see it and German users get an English
  flash. Move to Astro's path-based i18n (`/de/…`) rendered at build time, with
  `translations.ts` as the single source of truth.

### 4. Contact endpoint hardening
- ~~No rate limiting, honeypot, or length caps; replies didn't target the requester~~ →
  **fixed:** honeypot field, per-IP rate limit (best effort per instance), field length
  caps, `reply_to` set. For production-grade rate limiting use Vercel KV or Turnstile.

## Feature ideas

1. **Live GitHub-backed transparency widgets** — real commit feed, roadmap from GitHub
   Projects, changelog from releases. Turns the transparency claim from copy into proof.
   Highest leverage.
2. **"Is it standard?" scope-check wizard** — answers the Step-01 question instantly,
   outputs a scope estimate, pre-fills the contact form.
3. **TCO calculator** on the managers page — SaaS seats × €/yr vs. one-time build.
4. **Live demos per module** + "Deploy to Vercel" buttons.
5. **Published fixed-price menu** on `/modules` — the copy already promises fixed prices;
   showing them is the ultimate anti-sales-funnel move.
6. **Dogfood MOD-01** — run client projects through the open-source Customer Portal
   module with public build logs.
7. **DE/EN content marketing** (journal) targeting "Individualsoftware Kosten"-style
   keywords; requires the path-based i18n fix first. Plus RSS + newsletter.

## Valuation assessment

The model — open-source software monetized through services — is proven, but at **agency
scale, not venture scale**.

- **As a venture startup: weak (~2/10).** Revenue scales with headcount; no recurring
  software revenue; MIT licensing deliberately gives away any product moat. Small
  services firms trade at ~0.5–1.5× revenue (vs. 5–15× ARR for SaaS). Pre-revenue with
  no shipped modules, today's strict valuation is essentially brand + site: near €0.
- **As a bootstrapped agency: good (~7/10).** Genuinely differentiated positioning in
  DACH — SaaS fatigue, procurement pain, and public-sector open-source/digital-
  sovereignty tailwinds are real. Plausible path: 2–4 people, €200–600k/yr.
- **AI cuts both ways:** LLM codegen makes 2–6-week CRUD delivery cheaper (margin
  tailwind) but erodes willingness to pay for standard software. The durable asset is
  trust, liability-bearing, and maintenance — which the honest branding supports.
- **Upgrade path:** a genuinely reusable module library that cuts delivery from weeks to
  days makes this a *productized service* (~2–4× revenue multiples); recurring SLA
  contracts are the second multiplier. Design for both from day one.

**Verdict:** as positioning, excellent (8/10); as a defensible venture, weak. The site
currently writes checks the repos can't cash — making the transparency claims literally
true (real GitHub org, real modules) is simultaneously the top improvement and the top
feature.
