// PUT  /api/host/merch/[id]           save edits
// POST /api/host/merch/[id] {action}  publish | close

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { closeListing, publishListing, saveListing } from "@/domain/merch/listings";
import { merchOwnerId } from "@/domain/merch/host-auth";
import { merchSalesOpen, resolveMerchPayee } from "@/domain/merch/runtime";
import { errorResponse } from "@/domain/merch/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await saveListing(owner, id, await req.json(), prisma, new Date());
    return NextResponse.json({ id });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { action } = (await req.json()) as { action?: string };
    if (action === "publish") {
      if (!merchSalesOpen()) return NextResponse.json({ error: "New merch sales are switched off right now." }, { status: 409 });
      await publishListing(owner, id, prisma, resolveMerchPayee, new Date());
    } else if (action === "close") await closeListing(owner, id, prisma, new Date());
    else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
