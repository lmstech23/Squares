import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const host = await prisma.host.findUnique({ where: { supabaseUserId: user.id } });
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });

    const { mode } = await request.json();
    if (mode !== "cash" && mode !== "stripe") {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    await prisma.host.update({
      where: { id: host.id },
      data: { paymentPreference: mode },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
