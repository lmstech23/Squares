import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const { email, phone, token, type } = await request.json();

    const supabase = await createClient();

    let result;
    if (type === "sms") {
      result = await supabase.auth.verifyOtp({
        phone,
        token,
        type: "sms",
      });
    } else {
      result = await supabase.auth.verifyOtp({
        email,
        token,
        type: "email",
      });
    }

    if (result.error) {
      return NextResponse.json(
        { error: result.error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
