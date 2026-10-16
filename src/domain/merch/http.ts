// Small HTTP helpers shared by merch routes.

import { NextResponse } from "next/server";
import { isMerchError } from "./errors.ts";

export function errorResponse(e: unknown) {
  if (isMerchError(e)) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  console.error("merch route error:", e);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

export function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** First hop of x-forwarded-for (Vercel sets it), else x-real-ip. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip");
}
