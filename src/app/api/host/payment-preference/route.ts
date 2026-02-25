import { NextResponse } from "next/server";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const host = await getHost();
  if (!host) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { mode } = await request.json();
  if (mode !== "stripe" && mode !== "cash") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  await prisma.host.update({
    where: { id: host.id },
    data: { paymentPreference: mode },
  });

  return NextResponse.json({ ok: true });
}
