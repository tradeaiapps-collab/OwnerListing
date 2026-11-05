"use client";
import { ForecastPanel } from "../../staff/analytics/forecast-panel";

/** The staff market forecast, for agents: area and property-type price trends with 80% and 95% ranges. */
export default function AgentMarketForecast() {
  return (
    <main className="admin-page">
      <h1>Market forecast</h1>
      <p><a href="/agent/workspace">Back to your workspace</a></p>
      <ForecastPanel endpoint="/api/agent/market-forecast" />
    </main>
  );
}
