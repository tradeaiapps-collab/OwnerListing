export default function Home() {
  return (
    <main>
      <h1>OwnerListing</h1>
      <p>Internal build. Not live; no listings are published.</p>
      <p><a href="/api/auth/google/start">Sign in with Google</a> (property owners and agents)</p>
      <p><a href="/api/auth/google/start?as=buyer">Sign in with Google as a buyer</a></p>
      <p><a href="/listings">Listings</a> · <a href="/listings/new">Create a listing</a> · <a href="/listings/mine">My listings</a></p>
    </main>
  );
}
