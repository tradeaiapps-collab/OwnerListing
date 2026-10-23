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
This is a starter codebase, not a production-ready marketplace. It does not yet include authentication, a database adapter, payments, search, media processing, Meta integration, e-signatures, or legal-approved state disclosure content. Do not deploy publicly until G0/G1 controls and Australian legal review are complete.

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
2. Add PostgreSQL migrations and transactional audit-event persistence.
3. Add OIDC authentication, MFA, RBAC and record-level authorization.
4. Implement state-specific disclosure configuration with compliance-owned content.
5. Add listing API and frontend against these domain rules.
6. Add observability, feature flags, security controls and CI.
