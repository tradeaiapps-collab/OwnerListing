import type { Metadata } from "next";
import OfflineActions from "./offline-actions";

export const metadata: Metadata = { title: "You are offline", robots: { index: false, follow: false } };

/** Shown by the service worker when a page cannot be loaded without a connection. Contains no account data. */
export default function OfflinePage() {
  return (
    <main className="offline-page">
      <h1>You are offline</h1>
      <p className="muted">This page needs an internet connection. Check your connection, then try again. Your saved searches and listings are safe.</p>
      <OfflineActions />
    </main>
  );
}
