import { SUPPORT_TOPICS, supportEmail } from "../../src/domain/legal-pages";
import "../styles/legal.css";

export default function Support() {
  const email = supportEmail();
  return (
    <main className="legal">
      <h1>Support</h1>
      <p>Answers to common questions, and how to reach us. In an emergency call 000.</p>
      <div className="support-list">
        {SUPPORT_TOPICS.map(t => (
          <details key={t.id} id={t.id}>
            <summary>{t.question}</summary>
            <p>{t.answer}</p>
          </details>
        ))}
      </div>
      <section className="legal-contact" aria-labelledby="contact-h">
        <h2 id="contact-h">Contact us</h2>
        <p>Email <a href={`mailto:${email}`}>{email}</a>. Please write from the address on your account and include the listing link if your question is about a listing. For privacy requests see the <a href="/privacy">Privacy policy</a>.</p>
      </section>
    </main>
  );
}
