import { NextResponse } from "next/server";
import { forecastResponse } from "../../../../../src/server/market-forecast-response";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** 12-month price forecast for ?area=&type= with 80% and 95% ranges. Staff with report.sales. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  return forecastResponse(req);
}

export const GET = withApi(handleGet);
