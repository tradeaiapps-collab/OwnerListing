/** Internal-build identity, accepted only outside production. Replaced when Google login lands. */
export const DEV_HEADERS = {
  "content-type": "application/json",
  "x-dev-user-id": "dev-owner",
  "x-dev-user-type": "owner"
} as const;

export const fieldStyle = { width: "100%", boxSizing: "border-box", padding: 8, fontSize: 16 } as const;
