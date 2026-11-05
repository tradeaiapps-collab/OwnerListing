import { readBrand } from "../config/brand";
import { API_SCOPES, API_RATE, SCOPE_DESCRIPTIONS } from "./api-keys";
import { WEBHOOK_EVENTS } from "./webhooks";

/** The OpenAPI 3.1 description of the public API. Served at /api/v1/openapi; tests check it against the real route files. */
type Json = Record<string, unknown>;
const err = (description: string): Json => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const ok = (schema: Json, description = "Success"): Json => ({ description, content: { "application/json": { schema } } });
const idParam: Json = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const idemHeader: Json = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" }, description: "Required on every write. Reuse it only to retry the same request." };
const common = { "401": err("Missing, invalid or revoked credentials."), "403": err("The key lacks the required scope."), "429": err("Rate limit reached. Wait for Retry-After seconds.") };

export function buildOpenApi(baseUrl = ""): Json {
  const bearer = (scope: string): Json[] => [{ apiKey: [scope] }, { oauth2: [scope] }];
  return {
    openapi: "3.1.0",
    info: {
      title: `${readBrand().name} API`,
      version: "1.0.0",
      description: `Read listings and offers, and subscribe to events. Authenticate with an API key (Authorization: Bearer olk_...) or exchange it for a one-hour token at /oauth/token. Limit: ${API_RATE.perKey} requests per ${API_RATE.windowSeconds} seconds per key. Every v1 write needs an Idempotency-Key header. Errors use one shape: { error: { code, message, correlationId } }.`
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [
      { name: "Listings", description: "Published listings and your own." },
      { name: "Offers", description: "Offers on your listings." },
      { name: "Webhooks", description: "Event subscriptions." },
      { name: "Auth", description: "OAuth 2.0 client credentials." },
      { name: "Developer", description: "Usage and help." }
    ],
    paths: {
      "/public/listings": { get: {
        tags: ["Listings"], summary: "Search published listings", security: bearer("listings.read"),
        description: "Filters: q, suburb, minPrice, maxPrice, bedrooms, type, transactionType, sort, page, pageSize.",
        parameters: [{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } }, { name: "pageSize", in: "query", schema: { type: "integer", maximum: 100 } }],
        responses: { "200": ok({ $ref: "#/components/schemas/ListingPage" }), ...common } } },
      "/public/listings/{id}": { get: {
        tags: ["Listings"], summary: "Get one published listing", security: bearer("listings.read"), parameters: [idParam],
        responses: { "200": ok({ $ref: "#/components/schemas/Listing" }), "404": err("Not found or not published."), ...common } } },
      "/me/listings": { get: {
        tags: ["Listings"], summary: "List your own listings (any status)", security: bearer("listings.read"),
        responses: { "200": ok({ type: "object", properties: { listings: { type: "array", items: { $ref: "#/components/schemas/Listing" } } } }), ...common } } },
      "/me/offers": { get: {
        tags: ["Offers"], summary: "List offers on your listings", security: bearer("offers.read"),
        description: "Id, listing, price, status and time only. Conditions, buyer identity and negotiation notes are not exposed.",
        responses: { "200": ok({ type: "object", properties: { offers: { type: "array", items: { $ref: "#/components/schemas/Offer" } } } }), ...common } } },
      "/developer/webhooks": {
        get: { tags: ["Webhooks"], summary: "List your webhook endpoints", security: bearer("webhooks.manage"),
          responses: { "200": ok({ type: "object", properties: { endpoints: { type: "array", items: { $ref: "#/components/schemas/WebhookEndpoint" } } } }), ...common } },
        post: { tags: ["Webhooks"], summary: "Create a webhook endpoint", security: bearer("webhooks.manage"), parameters: [idemHeader],
          description: "The signing secret is returned once. Deliveries carry OL-Signature: t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<body>\">.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url", "events"], properties: { url: { type: "string", format: "uri", description: "https only, public host." }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS] } } } } } } },
          responses: { "201": ok({ $ref: "#/components/schemas/WebhookEndpointWithSecret" }, "Created"), "400": err("Invalid URL or events."), "422": err("Endpoint limit reached."), ...common } } },
      "/developer/webhooks/{id}": { delete: {
        tags: ["Webhooks"], summary: "Delete a webhook endpoint", security: bearer("webhooks.manage"), parameters: [idParam, idemHeader],
        responses: { "200": ok({ type: "object", properties: { deleted: { type: "boolean" } } }), "404": err("Not found."), ...common } } },
      "/developer/usage": { get: {
        tags: ["Developer"], summary: "Your API usage and suggestions", security: bearer("listings.read"),
        description: "Last 7 days of calls grouped by route and status, with suggestions (for example: use webhooks instead of polling).",
        responses: { "200": ok({ $ref: "#/components/schemas/UsageReport" }), ...common } } },
      "/developer/assistant": { post: {
        tags: ["Developer"], summary: "Ask Elena about the API", security: bearer("listings.read"), parameters: [idemHeader],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question: { type: "string", maxLength: 500 } } } } } },
        responses: { "200": ok({ type: "object", properties: { answer: { type: "string" }, references: { type: "array", items: { type: "string" } } } }), ...common } } },
      "/oauth/token": { post: {
        tags: ["Auth"], summary: "Exchange client credentials for a bearer token", security: [],
        requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["grant_type", "client_id", "client_secret"], properties: {
          grant_type: { type: "string", enum: ["client_credentials"] }, client_id: { type: "string", description: "olk_ followed by 12 characters" }, client_secret: { type: "string" }, scope: { type: "string", description: "Space separated; defaults to all the key's scopes." } } } } } },
        responses: { "200": ok({ type: "object", properties: { access_token: { type: "string" }, token_type: { type: "string", enum: ["Bearer"] }, expires_in: { type: "integer" }, scope: { type: "string" } } }),
          "400": err("invalid_request or unsupported_grant_type."), "401": err("invalid_client."), "403": err("invalid_scope.") } } },
      "/openapi": { get: { tags: ["Developer"], summary: "This document", security: [], responses: { "200": ok({ type: "object" }) } } }
    },
    webhooks: Object.fromEntries(WEBHOOK_EVENTS.map(e => [e, { post: {
      summary: `Event ${e}`, description: "Delivered as JSON to your endpoint. Respond 2xx within 8 seconds. Failed deliveries retry after 1 min, 5 min, 30 min and 2 h; the id is the same each time, so de-duplicate on it.",
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } } }, responses: { "200": { description: "Received." } } } }])),
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "API key (olk_...) or an olt_ token. Scopes: " + API_SCOPES.map(s => `${s} (${SCOPE_DESCRIPTIONS[s]})`).join("; ") },
        oauth2: { type: "oauth2", flows: { clientCredentials: { tokenUrl: `${baseUrl}/api/v1/oauth/token`, scopes: Object.fromEntries(API_SCOPES.map(s => [s, SCOPE_DESCRIPTIONS[s]])) } } }
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, correlationId: { type: "string" } } } } },
        Listing: { type: "object", properties: { id: { type: "string", format: "uuid" }, title: { type: "string" }, address: { type: "string" }, suburb: { type: "string" }, transactionType: { enum: ["sale", "rent"] }, propertyType: { type: "string" }, status: { type: "string" }, description: { type: "string" } } },
        ListingPage: { type: "object", properties: { listings: { type: "array", items: { $ref: "#/components/schemas/Listing" } }, total: { type: "integer" }, page: { type: "integer" }, pageSize: { type: "integer" } } },
        Offer: { type: "object", properties: { id: { type: "string", format: "uuid" }, listingId: { type: "string", format: "uuid" }, priceCents: { type: "integer" }, status: { type: "string" }, submittedAt: { type: "string", format: "date-time" } } },
        WebhookEndpoint: { type: "object", properties: { id: { type: "string", format: "uuid" }, url: { type: "string" }, events: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, createdAt: { type: "string", format: "date-time" } } },
        WebhookEndpointWithSecret: { allOf: [{ $ref: "#/components/schemas/WebhookEndpoint" }, { type: "object", properties: { secret: { type: "string" } } }] },
        Event: { type: "object", properties: { id: { type: "string", format: "uuid" }, type: { enum: [...WEBHOOK_EVENTS] }, createdAt: { type: "string", format: "date-time" }, data: { type: "object", description: "Ids and statuses only; fetch details with the API." } } },
        UsageReport: { type: "object", properties: { totalCalls: { type: "integer" }, errorRate: { type: "number" }, topRoutes: { type: "array", items: { type: "object" } }, suggestions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } } } } } }
      }
    }
  };
}

/** Every `METHOD /path` the spec documents, as served under /api/v1 (used by the route-coverage test). */
export function documentedOperations(spec: Json = buildOpenApi()): string[] {
  const out: string[] = [];
  for (const [p, ops] of Object.entries(spec["paths"] as Record<string, Record<string, unknown>>)) {
    for (const m of Object.keys(ops)) out.push(`${m.toUpperCase()} ${p}`);
  }
  return out.sort();
}
