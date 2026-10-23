# Real Estate Marketplace — Build 001

This is the first implementation slice based on `Real Estate Marketplace Implementation Playbook` v1.0 (20 Oct 2026).

## Scope of this build
- TypeScript domain foundation for property listings.
- State/territory disclosure gate before publication.
- Append-only audit event model.
- Bounded offer-response policy: AI may draft, but cannot accept an offer or bind a party.
- Investment module hard-disabled until Gate G4.
- Unit tests for release-blocking rules.

## Deliberate limits
This is not a production-ready marketplace. Google login, PostgreSQL migrations and listing pages are in place (PR #4). It does not yet include payments (Westpac PayWay is not connected), search, media processing, Meta integration, e-signatures, or legal-approved state disclosure content. Do not deploy publicly until G0/G1 controls and Australian legal review are complete.

## Requirements
- Node.js 20+
- npm

## Run
```bash
npm install
npm test
npm run typecheck
```

## Next implementation sequence
1. Approve architecture decision records and deployment/provider choices.
2. Done (PR #4): PostgreSQL migrations and Google login. Copy `.env.example` to `.env` for database and login settings.
3. Connect audit writes to PostgreSQL; add MFA, RBAC and record-level authorization on routes.
4. Implement state-specific disclosure configuration with compliance-owned content.
5. Wire the listing API and pages to the publish gates and domain rules.
6. Done: CI runs typecheck and tests (`.github/workflows/ci.yml`). Observability, feature flags and security controls remain.
