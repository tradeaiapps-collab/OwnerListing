# Contractor sign-up and sign-in

A contractor is an `app_user` with `user_type = 'vendor'` (photographer, building inspector, pest control, other trade).

- **Sign-up**: `/signup?as=vendor`, email and password only (Google cannot create a contractor). The chosen trade rides on the emailed link (`email_auth_token.trade`); the account, an unpublished `contractor_page` and an empty `contractor_profile` for the trade are created only when the link is used. Lands on `/contractor/profile`.
- **Sign-in**: the normal `/login` form and password reset now accept vendor accounts. Two-step sign-in is optional (required once enrolled), linked from the contractor menu as Security.
- **Roles**: "vendor" is never an addable or switchable role (`isUserRole` is false, `activateRole` refuses vendor accounts).
- **Access**: `actorFromRequestChecked` treats a vendor session as signed out for every API path not listed in `src/domain/contractor-access.ts` (`VENDOR_API_PREFIXES`). New contractor APIs go under `/api/contractor/` or get listed there. MFA, sign-out and `/api/auth/me` use the session directly and are not gated.
- **Demo**: `scripts/seed-demo.mjs` creates the four demo contractors as vendors (and converts older agent-type ones). Sign in at `/dev-login`.
- **Not here**: licence/insurance/ABN verification and the verified badge (package 4); Google sign-in for contractors; account deletion and settings screens for contractors.
