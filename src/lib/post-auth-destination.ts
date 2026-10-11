// Where a person goes after signing in — Daali Slice 1, S1.5.
//
// Auth spec, "Post-auth gate and routing" and "Allowlisted next":
//   - an allowlisted `next` under /host or /invite needs only a non-anonymous
//     signed-in user, so an organizer mid-setup can still follow a link
//     straight to their fundraiser;
//   - otherwise the organizer state decides:
//       SIGNED_OUT                  /sign-in
//       NO_PROFILE, SETUP_INCOMPLETE /setup
//       COMPLETE                    today's default (/host/boards) until /home
//                                   exists in S1.6
//
// NO_PROFILE goes to /setup too: a confirmed-email user never stays there
// (finalize creates the row first), so what remains is an existing account
// with no email, whose next step is adding one at /setup.
//
// PURE. Both /auth/callback and completeSignIn use it.

import { allowedNext } from "@/lib/next-path";
import { DEFAULT_AFTER_LOGIN } from "@/lib/login-return";
import type { OrganizerState } from "@/lib/organizer-state";

export function postAuthDestination(state: OrganizerState, next: string | null | undefined): string {
  if (state === "SIGNED_OUT") return "/sign-in";
  const allowed = allowedNext(next);
  if (allowed && (allowed.startsWith("/host/") || allowed.startsWith("/invite/"))) return allowed;
  if (state === "COMPLETE") return DEFAULT_AFTER_LOGIN;
  return "/setup";
}
