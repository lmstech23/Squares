// Where a person goes after signing in — Daali Slice 1, S1.5, with /home from
// S1.6.
//
// Auth spec, "Post-auth gate and routing" and "Allowlisted next":
//   - an allowlisted `next` under /host or /invite needs only a non-anonymous
//     signed-in user, so an organizer mid-setup can still follow a link
//     straight to their fundraiser or invitation;
//   - a `next` of /home requires COMPLETE;
//   - a `next` of /gameday/<token> (S1.7) comes back once setup is done: an
//     incomplete account goes to /setup carrying it, and /setup returns it there
//     after the last step (ruled Oct 11). The page itself works in any state;
//   - otherwise the organizer state decides:
//       SIGNED_OUT                   /sign-in
//       NO_PROFILE, SETUP_INCOMPLETE /setup
//       COMPLETE                     /home
//
// No path here leads to /host/boards, /host/payment-setup or /host/stripe
// (T16). Those pages still open for anyone who goes to them directly.
//
// NO_PROFILE goes to /setup too: a confirmed-email user never stays there
// (finalize creates the row first), so what remains is an existing account
// with no email, whose next step is adding one at /setup.
//
// PURE. Both /auth/callback and completeSignIn use it.

import { allowedNext } from "@/lib/next-path";
import type { OrganizerState } from "@/lib/organizer-state";

/** Your Daali. Where a COMPLETE organizer lands when there is no allowlisted next. */
export const HOME = "/home";

export function postAuthDestination(state: OrganizerState, next: string | null | undefined): string {
  if (state === "SIGNED_OUT") return "/sign-in";
  const allowed = allowedNext(next);
  if (allowed && (allowed.startsWith("/host/") || allowed.startsWith("/invite/"))) return allowed;
  if (allowed && allowed.startsWith("/gameday/")) {
    return state === "COMPLETE" ? allowed : `/setup?next=${encodeURIComponent(allowed)}`;
  }
  return state === "COMPLETE" ? HOME : "/setup";
}
