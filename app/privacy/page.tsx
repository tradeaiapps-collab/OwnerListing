import LegalPage from "../legal-page";
import { PRIVACY, supportEmail } from "../../src/domain/legal-pages";

export default function Privacy() {
  const email = supportEmail();
  return (
    <LegalPage doc={PRIVACY}>
      <section className="legal-contact" aria-labelledby="contact-h">
        <h2 id="contact-h">Contact</h2>
        <p>Privacy questions, access or correction requests and complaints: <a href={`mailto:${email}`}>{email}</a> or the <a href="/support">Support page</a>. Related: <a href="/terms">Terms of use</a>.</p>
      </section>
    </LegalPage>
  );
}
