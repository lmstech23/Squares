import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
      select: { boardCredits: true },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    return NextResponse.json({ credits: host.boardCredits });
  } catch (error) {
    console.error("Credit balance error:", error);
    return NextResponse.json(
      { error: "Failed to fetch credit balance." },
      { status: 500 }
    );
  }
}
