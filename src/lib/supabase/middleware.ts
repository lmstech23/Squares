import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** `/host` itself or anything beneath `/host/` — never `/hostX`. */
export function isHostPath(pathname: string): boolean {
  return pathname === "/host" || pathname.startsWith("/host/");
}

/** Paths that need a signed-in, non-anonymous user: /host/…, /setup and /home. */
export function requiresSignIn(pathname: string): boolean {
  return isHostPath(pathname) || pathname === "/setup" || pathname === "/home";
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

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

 const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protect /host routes, /setup and /home. An anonymous user counts as signed out (Auth spec,
  // "Where the gate runs"); `next` is checked against the allowlist where it
  // is used, not here.
  if ((!user || user.is_anonymous) && requiresSignIn(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  // /host is retired as a destination: it goes to Your Daali (Auth spec,
  // "Retired destinations"). Redirected HERE rather than only in host/page.tsx,
  // because the legacy host/layout.tsx runs getHost() before that page renders
  // and would create a Host on the way to /home (found in S1.6).
  if (request.nextUrl.pathname === "/host") {
    const url = request.nextUrl.clone();
    url.pathname = "/home";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
