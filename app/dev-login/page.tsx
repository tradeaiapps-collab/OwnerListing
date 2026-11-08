import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readAppMode } from "../../src/config/app-mode";
import { DEV_EMAIL_DOMAIN, devLoginAllowed, devLoginSurface } from "../../src/server/dev-login";
import { getDb } from "../../src/server/context";
import DevLoginButtons, { type DevAccount } from "./buttons";

/** A buyer account that holds the investor role and is currently viewing as one. */
const isInvestor = (r: Record<string, unknown>) => r["user_type"] === "buyer" && r["active_role"] === "investor" && Array.isArray(r["roles"]) && r["roles"].includes("investor");

export const dynamic = "force-dynamic";
export const metadata = { title: "Dev sign-in (local only)" };

/** DEV-ONLY page. notFound() (404) unless devLoginAllowed(); see src/server/dev-login.ts. */
export default async function DevLogin() {
  const h = await headers();
  const host = h.get("host") ?? "";
  if (!devLoginAllowed({ url: `http://${host}/dev-login`, headers: { get: n => h.get(n) } })) notFound();
  const surface = devLoginSurface(readAppMode());
  const rows = (await getDb().query(
    `SELECT u.id, u.display_name, u.user_type, u.email, i.role, u.roles, u.active_role, bv.email_verified_at, bv.id_verified_at
       FROM app_user u
       LEFT JOIN staff_invite i ON i.email = lower(u.email::text) AND i.revoked_at IS NULL AND i.accepted_at IS NOT NULL
       LEFT JOIN buyer_verification bv ON bv.user_id = u.id
      WHERE u.status = 'active' AND u.email LIKE $1 ORDER BY u.user_type, u.display_name`,
    [`%${DEV_EMAIL_DOMAIN}`]
  )).rows;
  const accounts: DevAccount[] = rows
    .filter(r => (r["user_type"] === "admin" ? surface.staff && !!r["role"] : surface.users))
    .map(r => ({
      id: String(r["id"]), name: String(r["display_name"]), email: String(r["email"]),
      kind: r["user_type"] === "admin" ? `staff: ${String(r["role"])}` : isInvestor(r) ? "investor" : String(r["user_type"]),
      note: r["user_type"] === "buyer" ? (r["id_verified_at"] ? "fully verified" : r["email_verified_at"] ? "email verified only" : "unverified") : ""
    }));
  console.warn("[dev-login] WARNING: dev sign-in page served. Local testing only; never enable DEV_LOGIN outside your own PC.");
  return (
    <main>
      <div role="alert" style={{ background: "#b00020", color: "#fff", padding: "12px 16px", borderRadius: 8, margin: "12px 0", fontWeight: 600 }}>
        DEV SIGN-IN. Local testing only. This page does not exist in production. Anyone who can open it can sign in as any demo account.
      </div>
      <h1>{surface.staff && !surface.users ? "Sign in as a staff member" : "Sign in as a demo user"}</h1>
      <p>Click an account to sign in without Google. Demo accounts only ({DEV_EMAIL_DOMAIN}).</p>
      <p>Want your own account? <a href="/login">Sign in</a> or <a href="/signup">create an account</a>.</p>
      {accounts.length === 0 ? <p>No demo accounts found. Run the seed (see docs/LOCAL_TEST.md).</p> : <DevLoginButtons accounts={accounts} />}
    </main>
  );
}
