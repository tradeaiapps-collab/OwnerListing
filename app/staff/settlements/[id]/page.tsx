"use client";
import { use, useEffect, useState } from "react";
import { RiskPanel, type RiskData } from "../../../settlements/risk-panel";
import { loadError } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/settlement.css";

/** One settlement's risk for staff: score, factors, next step. Listing title only, no buyer or owner details. */
export default function StaffSettlementRisk({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<(RiskData & { listingTitle: string }) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/staff/settlements/${id}/risk`).then(async res => {
      if (res.ok) setR(await res.json());
      else setError(res.status === 404 ? "This settlement is closed or was not found." : loadError(res.status));
    }).catch(() => setError(loadError(0)));
  }, [id]);
  return (
    <main className="admin-page">
      <p><a href="/staff/settlements">Back to settlements</a></p>
      <h1>{r?.listingTitle ?? "Settlement risk"}</h1>
      {error && <p role="alert">{error}</p>}
      {!error && !r && <p className="muted" role="status">Loading…</p>}
      {r && <RiskPanel r={r} who="staff" />}
    </main>
  );
}
