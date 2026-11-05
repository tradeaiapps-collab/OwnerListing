# Lead ads: setup and routing

Leads from Facebook/Instagram Lead Ads and Google lead form extensions arrive at `/staff/ad-leads` (capture, inbox, spend) and are sent to an agent automatically (this page). Keys are listed in `PROVIDER_KEYS.md`.

## Connect Facebook / Instagram
1. developers.facebook.com: create a Business app, add **Webhooks** and **Leads Access**. `leads_retrieval` needs Advanced Access (app review).
2. Set `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (any 16+ char string you choose) and `META_PAGE_ACCESS_TOKEN` (long-lived Page token). Run `npm run check:providers -- --production`.
3. Webhooks > Page > callback URL `https://<site>/api/webhooks/ad-leads/meta`, the same verify token, subscribe the `leadgen` field, and subscribe the Page to the app.
4. In `/staff/ad-leads` > Ad accounts add the Page id. Use Meta's Lead Ads Testing Tool to send a test lead; it appears marked as a test and is not routed or emailed.
5. Name form questions so they match: `full_name`, `email`, `phone_number`, `city` or `suburb`, `zip_code`/`post_code`, and a custom question whose key contains `property_type` (answers such as "Apartment" or "Town house" are mapped to our types). Campaign and ad names are kept on the lead.

## Connect Google
Add a Google source in `/staff/ad-leads`, copy the one-time key and the URL `https://<site>/api/webhooks/ad-leads/google/<source id>` into the lead form extension's webhook settings. A custom question whose text contains "type of property" is read as the property type.

## Who gets a lead
In order, the first that applies:
1. **Routing rule** (`/staff/ad-leads/rules`): rules in order (lowest first); a rule matches when every condition it sets matches (postcodes, suburbs, property types, interest). Rules can be for one source or all. The agent with the fewest open leads among those the rule names gets it.
2. **Agent service area**: an active agent taking new work whose profile (`/agent/profile`) lists the lead's postcode (best) or suburb. If the agent lists property types, the lead's type must be one of them. Ties go to the agent with the fewest open leads.
3. **The source's default agent.**
4. Otherwise the lead waits unassigned for staff.

Only active agent accounts that are accepting new work are ever chosen, whoever a rule or default names. Test leads are never routed. The inbox and the agent's own list show how each lead was routed. Open leads = assigned and not qualified or lost.

## Agents
`/agent/ad-leads` shows only the agent's own leads (not test leads), with contact details, campaign and why it was routed to them, and lets them mark it contacted, qualified or lost (a reason is needed for lost). The agent gets an email when a lead is assigned.

## Before go-live
- Apply migrations (`npm run migrate`): `20261105180000_ad_leads.sql` then `20261105190000_ad_lead_routing.sql`.
- Leads hold names, emails and phone numbers entered in an ad form: include them in the privacy policy and retention review.
- Nothing has been tested against live Meta or Google; check field names against the first real test leads.
