import { NextResponse } from "next/server";
import type { Failure } from "../domain/listing-service";

const STATUS: Record<Failure["code"], number> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409 };

export const failure = (f: Failure) => NextResponse.json({ error: f.message }, { status: STATUS[f.code] });
export const unauthenticated = () => NextResponse.json({ error: "Sign in required." }, { status: 401 });
