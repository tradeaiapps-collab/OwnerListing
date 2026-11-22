"use client";
import type { ReactNode } from "react";
import { JSON_HEADERS } from "../listings/ui";
import { useT } from "../i18n-provider";

export interface Providers { google: boolean; email: boolean; dev?: boolean }

export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; d: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false, status: 0, d: { error: "Check your connection and try again." } };
  return { ok: r.ok, status: r.status, d: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
export const errorOf = (d: Record<string, unknown>, fallback: string) => (typeof d["error"] === "string" ? d["error"] : fallback);

export const loadProviders = (): Promise<Providers> =>
  fetch("/api/auth/providers").then(r => (r.ok ? r.json() : null)).then(p => ({ google: p?.google === true, email: p?.email === true, dev: p?.dev === true }), () => ({ google: false, email: false }));

/** The centred card every sign-in page uses. */
export function AuthCard({ title, lead, children, foot }: { title: string; lead?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1>{title}</h1>
        {lead && <p className="auth-lead">{lead}</p>}
        {children}
      </div>
      {foot && <p className="auth-foot">{foot}</p>}
    </main>
  );
}

/** Google's multi-colour "G" (brand guidelines allow it on a neutral button). */
const GoogleMark = () => (
  <svg className="auth-google-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
  </svg>
);

export function GoogleButton({ href, label }: { href: string; label: string }) {
  return <a className="button secondary auth-google" href={href}><GoogleMark />{label}</a>;
}

export function OrDivider() {
  const t = useT();
  return <p className="auth-or" role="separator" aria-label={t("or")}><span>{t("or")}</span></p>;
}
