// POST /api/host/merch — create a merch sale (draft).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveListing } from "@/domain/merch/listings";
import { merchOwnerId } from "@/domain/merch/host-auth";
import { merchEnabled } from "@/domain/merch/runtime";
import { errorResponse, notFound } from "@/domain/merch/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!merchEnabled()) return notFound();
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const id = await saveListing(owner, null, await req.json(), prisma, new Date());
    return NextResponse.json({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
