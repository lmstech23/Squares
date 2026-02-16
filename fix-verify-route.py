#!/usr/bin/env python3
"""Fix the verify-otp route to explicitly set cookies on the response.
Run from your project root: python fix-verify-route.py
"""

CONTENT = '''import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { email, phone, token, type } = await request.json();

  const response = NextResponse.json({ success: true });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  let result;
  if (type === "sms") {
    result = await supabase.auth.verifyOtp({ phone, token, type: "sms" });
  } else {
    result = await supabase.auth.verifyOtp({ email, token, type: "email" });
  }

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 400 });
  }

  return response;
}
'''

with open("src/app/api/auth/verify-otp/route.ts", "w", encoding="utf-8") as f:
    f.write(CONTENT)
print("\u2713 Fixed: src/app/api/auth/verify-otp/route.ts")
print()
print("Key fix: creates Supabase client that writes cookies")
print("directly onto the response object we return.")
print()
print('Next: git add -A && git commit -m "fix: verify-otp sets cookies on response" && git push origin main')
