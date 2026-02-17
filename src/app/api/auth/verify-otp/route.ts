import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const { email, phone, token, type } = await request.json();

    const supabase = await createClient();

    const result =
      type === "sms"
        ? await supabase.auth.verifyOtp({ phone, token, type: "sms" })
        : await supabase.auth.verifyOtp({ email, token, type: "email" });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }

    // ✅ Redirect from the server so cookies are committed before navigation
    return NextResponse.json({ ok: true, redirectTo: "/host/boards" });
} catch {
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
