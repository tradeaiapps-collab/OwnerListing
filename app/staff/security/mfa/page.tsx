import { MfaPanel } from "../../../mfa/mfa-panel";
import "../../../styles/admin.css";
import "../../../styles/staff.css";

/** Staff two-step sign-in: set up an authenticator app, check it, manage methods. Optional to sign in, needed for payout approvals and dispute resolution. */
export default function StaffMfa() {
  return <MfaPanel api="/api/staff/mfa" signIn="/api/auth/google/start?as=staff" home="/staff" />;
}
