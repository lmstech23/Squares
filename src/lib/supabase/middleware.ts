import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** `/host` itself or anything beneath `/host/` — never `/hostX`. */
export function isHostPath(pathname: string): boolean {
  return pathname === "/host" || pathname.startsWith("/host/");
}

/** Paths that need a signed-in, non-anonymous user: /host/… and /setup. */
export function requiresSignIn(pathname: string): boolean {
  return isHostPath(pathname) || pathname === "/setup";
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

  // Protect /host routes and /setup. An anonymous user counts as signed out (Auth spec,
  // "Where the gate runs"); `next` is checked against the allowlist where it
  // is used, not here.
  if ((!user || user.is_anonymous) && requiresSignIn(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  return response;
}
