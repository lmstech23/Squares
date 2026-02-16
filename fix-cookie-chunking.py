#!/usr/bin/env python3
"""Fix: Chunk large cookies so browser doesn't silently drop them.
Run from your project root: python fix-cookie-chunking.py
"""

# The verify-otp route's Set-Cookie is over 4KB.
# Browsers silently drop cookies that exceed the limit.
# Fix: chunk large cookies into smaller pieces.
# @supabase/ssr automatically reassembles chunks named like
# "cookie-name.0", "cookie-name.1" etc. when reading via getAll().

ROUTE_CONTENT = '''import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

const CHUNK_SIZE = 3500; // bytes, well under 4KB browser limit

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
            if (value.length > CHUNK_SIZE) {
              // Split into chunks the browser will accept
              const numChunks = Math.ceil(value.length / CHUNK_SIZE);
              for (let i = 0; i < numChunks; i++) {
                const chunk = value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                response.cookies.set(`${name}.${i}`, chunk, options);
              }
            } else {
              response.cookies.set(name, value, options);
            }
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
    f.write(ROUTE_CONTENT)
print("\u2713 Fixed: src/app/api/auth/verify-otp/route.ts")
print()
print("The auth token cookie was over 4KB.")
print("Browsers silently drop cookies that exceed the limit.")
print("Now chunking into ~3.5KB pieces that the browser will store.")
print("Supabase SSR automatically reassembles chunks on read.")
print()
print('Next: git add -A && git commit -m "fix: chunk auth cookie to fit browser 4KB limit" && git push origin main')
