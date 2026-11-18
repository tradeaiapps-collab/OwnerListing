"use client";

export default function OfflineActions() {
  return (
    <p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>Try again</button>{" "}
      <a className="btn btn-secondary" href="/">Go to the home page</a>
    </p>
  );
}
