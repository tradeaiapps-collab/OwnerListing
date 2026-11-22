import { supportEmail } from "../../../src/domain/legal-pages";

export const metadata = { title: "Delete account" };

export default function DeleteAccount() {
  const email = supportEmail();
  return (
    <main>
      <h1>Delete account</h1>
      <section className="acct-card" aria-labelledby="acct-del-h">
        <h2 id="acct-del-h">How deletion works</h2>
        <p>Deleting an account is done by our team so nothing is lost by accident. Your listings are archived, open offers are withdrawn and the other side is told. You have 30 days to ask us to restore it. Records we must keep by law are held for 7 years.</p>
        <p>To start, email <a href={`mailto:${email}`}>{email}</a> from the address on your account.</p>
        <p className="muted">Messages and published files are never deleted.</p>
      </section>
    </main>
  );
}
