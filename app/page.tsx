import { readBrand } from "../src/config/brand";

export const metadata = { title: readBrand().tagline };

export default function Home() {
  const brand = readBrand();
  return (
    <main>
      <section className="hero">
        <h1>{brand.tagline}</h1>
        <p className="lead">{brand.name} lets owners list their own homes. AI helps with replies and reports, but only you decide on offers. Internal build: not live, no listings are published.</p>
        <div className="actions">
          <a className="button" href="/api/auth/google/start">Sign in as owner or agent</a>
          <a className="button secondary" href="/api/auth/google/start?as=buyer">Sign in as buyer</a>
        </div>
      </section>
      <div className="actions">
        <a href="/listings">Browse listings</a>
        <a href="/listings/new">Create a listing</a>
        <a href="/listings/mine">My listings</a>
      </div>
    </main>
  );
}
