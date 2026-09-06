"use client";

import type { PublicPrice } from "@/lib/fundraiser-pricing";
import {
  purchaseUnit,
  ADMISSION,
  CONTRIBUTION_THANKS,
} from "@/lib/board-vocabulary";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ClaimSheet from "./claim-sheet";
import DonateSheet from "./donate-sheet";
import HoldTimer from "./hold-timer";

// Contributor board — fundraiser-board-v2.md §6 and §7.
//
// Mobile first: these links go into texts and parent chats, so this is
// designed at 360px. Four questions above the first scroll — what is this,
// how's it going, what's the fun, what do I do.
//
// Phase A boards carry no prize, so the third block is supporter momentum
// rather than a prize pool. Never leave a hole there: a no-prize board must
// not read as the diminished version of a prize board.
//
// Nothing here computes money from square count. `raised` is summed from
// pricePaidCents by the caller (invariant 43).

interface GridSquare {
  squareId: string;
  position: number;
  paymentStatus: string;
}

interface Props {
  title: string;
  causeDescription: string | null;
  hostName: string | null;
  squares: GridSquare[];
  /** The one price a contributor sees, from publicPriceDisplay() on the
      server. Never two prices - see src/lib/fundraiser-pricing.ts. */
  price: PublicPrice;
  /**
   * Set only on return from a donation-only card checkout, and only when the
   * ledger row for that session actually exists on this board. `settled` is
   * the row reading `confirmed`; `false` means the webhook has not landed yet.
   */
  donation: { settled: boolean; signupUrl: string | null } | null;
  /// Decided by the caller, not here: "is the changeover still ahead" depends
  /// on the current time, which makes it impure inside render.
  timezone: string | null;
  raisedCents: number;
  /// Null = no goal set. No bar, no denominator — v2 §7.
  goalCents: number | null;
  /// No longer displayed — money doc §10, see the note in the header block.
  /// Kept on the interface so the page's call site is unchanged.
  supporterCount?: number;
  openCount: number;
  slug: string;
  hasEvent: boolean;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  /// prizePoolPercent > 0. Gates prize language everywhere — never board type,
  /// because a Phase B fundraiser with prizes needs it back.
  hasPrize: boolean;
  /// A sign-up sheet exists on this board, so the helper checkbox has a
  /// destination. Sign-up addendum SS3.
  signupSheetExists: boolean;
  /// open | closing | closed. A closed campaign shows its final total and
  /// stops offering the claim button.
  status: string;
  handles: {
    venmo: string | null;
    zelle: string | null;
    cashapp: string | null;
    paypal: string | null;
  };
  /// Set on return from a completed checkout — v2 §6.
  confirmation: {
    positions: number[];
    admissionPasses: number;
    hasEvent: boolean;
    passesUrl: string | null;
    wantsToHelp: boolean;
    signupUrl: string | null;
  } | null;
}

function shortDate(date: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timeZone ?? "America/New_York",
  }).format(date);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/** "Sept 15" in the board's own timezone, never the server's. */
export default function FundraiserView({
  title,
  causeDescription,
  hostName,
  squares,
  price,
  donation,
  timezone,
  raisedCents,
  goalCents,
  openCount,
  slug,
  hasEvent,
  cashModeEnabled,
  stripeConnected,
  hasPrize,
  signupSheetExists,
  status,
  handles,
  confirmation,
}: Props) {
  const [claiming, setClaiming] = useState(false);
  const [donating, setDonating] = useState(false);
  const [reclaim, setReclaim] = useState<string[] | undefined>(undefined);
  // Selection lives on the board, so the checkout button can say how many
  // tickets are being bought before the sheet opens.
  const router = useRouter();

  // A hold this browser started, remembered at claim time. The server
  // timestamp is the truth; this is only how we know to show a countdown to
  // someone who came back from Stripe without paying.
  const [hold, setHold] = useState<{
    holdExpiresAt: string;
    squareIds: string[];
    /// Absent on holds stored before the switch actions shipped. Without it
    /// the banner falls back to its countdown-only shape rather than offering
    /// buttons that would 400.
    email?: string;
  } | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`daali-hold-${slug}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Drop a hold that expired long enough ago that the cron has certainly
      // resolved it — showing a stale countdown is worse than showing none.
      if (new Date(parsed.holdExpiresAt).getTime() < Date.now() - 15 * 60_000) {
        sessionStorage.removeItem(`daali-hold-${slug}`);
        return;
      }
      // sessionStorage cannot be read during SSR or from a state initializer
      // without risking a hydration mismatch, so a one-shot read after mount
      // is the only correct option here. Runs once per slug, sets state once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHold(parsed);
    } catch {
      // Unreadable or disabled storage — no countdown, nothing broken.
    }
  }, [slug]);

  // (a) The server is the authority on whether a hold is still live.
  //
  // `hold` is only a note this browser wrote to sessionStorage at claim time;
  // nothing cleared it on a successful return, so a confirmed purchase kept
  // rendering a countdown that eventually announced a release that was never
  // going to happen. Reconcile it against the statuses the page just rendered:
  // a hold whose squares are no longer pending is over, whether they were paid,
  // reserved, or released.
  const heldStatuses = hold
    ? hold.squareIds
        .map((id) => squares.find((sq) => sq.squareId === id)?.paymentStatus)
        .filter((st): st is string => st != null)
    : [];

  const holdResolvedByServer =
    hold != null && heldStatuses.length > 0 && !heldStatuses.includes("pending");

  useEffect(() => {
    if (!holdResolvedByServer) return;
    try {
      sessionStorage.removeItem(`daali-hold-${slug}`);
    } catch {
      // Storage unavailable — the render guard below still suppresses the UI.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHold(null);
  }, [holdResolvedByServer, slug]);

  // (c) A completed checkout can land back here before Stripe's webhook has
  // been delivered — the redirect and the webhook race, and the redirect
  // usually wins by a moment. The page is `force-dynamic`, so it renders the
  // truth AT REQUEST TIME and then never updates: no polling, no refresh on
  // focus. A contributor whose payment confirmed a second after landing sat
  // looking at "$0 raised · 99 open" with no reason to reload.
  //
  // `confirmation` is non-null only on return from checkout, which makes it a
  // reliable "just got back" signal. Refresh until this purchase's squares read
  // paid, then stop. Bounded, so a genuinely failed payment does not poll
  // forever.
  const confirmedPositions = confirmation?.positions ?? [];
  const purchaseSettled =
    confirmedPositions.length > 0 &&
    confirmedPositions.every(
      (pos) => squares.find((sq) => sq.position + 1 === pos)?.paymentStatus === "paid"
    );

  // Ten tries at two seconds is the twenty-second budget sign-up addendum §5
  // names. `pollExhausted` is what turns that budget into the fallback copy
  // rather than a spinner that never resolves.
  const [pollExhausted, setPollExhausted] = useState(false);

  // A donation whose webhook has not landed is the same race as a ticket
  // purchase whose squares have not flipped, so it uses the same poll rather
  // than a second one with its own budget.
  const awaitingWebhook =
    (confirmation != null && !purchaseSettled) ||
    (donation != null && !donation.settled);

  useEffect(() => {
    if (!awaitingWebhook) return;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (tries > 10) {
        clearInterval(id);
        setPollExhausted(true);
        return;
      }
      router.refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [awaitingWebhook, router]);

  // VOLUNTEER REDIRECT — sign-up addendum §5.
  //
  // Fires only once the server has minted a token, which it does only for a
  // CONFIRMED supporter. So this cannot race the webhook: while the purchase
  // is pending there is no url to navigate to, the poll above keeps refreshing,
  // and if twenty seconds pass without one the fallback below takes over.
  // DERIVED, not state. Whether we are navigating is entirely a function of
  // what the server sent — a token means go — so holding it in state would be
  // a second copy of a fact that already exists, kept in sync by an effect.
  // The page is in its post-purchase state. Same condition the confirmation
  // panel renders on, so the two can never disagree about which page this is.
  const showingConfirmation = Boolean(
    confirmation && confirmation.positions.length > 0
  );

  // NO AUTOMATIC NAVIGATION. Approved amendment to sign-up addendum §5: the
  // supporter reaches the sheet by choosing to.
  //
  // Two things the redirect broke, both observed on beta:
  //
  //   1. The confirmation was never read. Passes, amount and next steps were
  //      on screen for well under two seconds before the page changed under
  //      the person reading it.
  //   2. A BACK-BUTTON TRAP. router.push left the confirmation in history, so
  //      Back returned here, this effect re-armed on the restored page, and
  //      the supporter was thrown at the sheet again. No way back to the board
  //      except closing the tab.
  //
  // THE SAFETY PROPERTY §5 CARES ABOUT IS UNCHANGED, because the button
  // inherits the identical condition the redirect fired on: `signupUrl` is
  // non-null only when the SERVER minted a token, and it only mints one for a
  // supporter who is already `active`. So the button cannot appear before the
  // poll tick that sees the payment confirmed — the same instant the redirect
  // used to fire — and nobody reaches a sheet they are not yet eligible for.
  // Same destination, same token, same minting path. There is no second one.

  // The three things someone who backed out of Stripe might want. All go
  // through /api/checkout/resume, which already owns the identity check and
  // the Stripe session lookup — a second flow would be a second chance to get
  // the expire-before-mutate ordering wrong.
  const [holdBusy, setHoldBusy] = useState<null | "resume" | "cash" | "release">(null);
  const [holdError, setHoldError] = useState<string | null>(null);

  async function holdAction(action: "resume" | "cash" | "release") {
    if (!hold?.email || !hold.squareIds[0]) return;
    setHoldBusy(action);
    setHoldError(null);
    try {
      const res = await fetch("/api/checkout/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squareId: hold.squareIds[0], email: hold.email, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setHoldError(data.error || "Something went wrong.");
        setHoldBusy(null);
        return;
      }
      if (data.checkoutUrl) {
        // assign(), not `location.href =`. Same navigation; the assignment
        // form trips react-hooks/immutability.
        window.location.assign(data.checkoutUrl);
        return;
      }
      // Switched or released — the hold is over either way, so drop the note
      // this browser wrote and let the server's state render.
      clearHold();
      setHoldBusy(null);
      router.refresh();
    } catch {
      setHoldError("Something went wrong.");
      setHoldBusy(null);
    }
  }

  function clearHold() {
    try {
      sessionStorage.removeItem(`daali-hold-${slug}`);
    } catch {
      // Nothing to do — the banner is dismissed either way.
    }
    setHold(null);
  }
  // The price in force right now, and whether it is the early one. Both come
  // from publicPriceDisplay() on the server, which calls the SAME predicate
  // currentPriceCents() charges on. THE VIEW STAYS PURE and does not re-derive
  // "is the window still open" from a timestamp - a badge that decided that for
  // itself could advertise a discount the checkout no longer applies.
  const currentPrice = price.amountCents;

  // CTA language follows what the buyer actually receives.
  //
  // PRECEDENCE IS EXPLICIT, not `&&` ordering, so a Phase B board that is both
  // ticketed and prize-bearing cannot silently change wording when
  // prizePoolPercent goes above zero.
  //
  //   hasEvent  -> "Purchase tickets"        admission is something they need
  //                                          at a gate; on a board that is
  //                                          both, that is the more
  //                                          consequential fact
  //   hasPrize  -> "Get entries"             a drawing, gated on
  //                                          prizePoolPercent > 0, never on
  //                                          board type
  //   otherwise -> "Support this fundraiser"
  // One shared resolver — src/lib/board-vocabulary.ts. Never branched locally.
  const u = purchaseUnit({ boardType: "fundraiser", hasEvent, hasPrize });

  const ctaLabel = hasEvent
    ? `Purchase ${u.many} — ${money(currentPrice)}`
    : hasPrize
      ? `Get ${u.many} — ${money(currentPrice)}`
      : `Support this fundraiser — ${money(currentPrice)}`;

  // Clamped at 100% when raised exceeds the goal — the real figure still shows
  // above the bar. v2 §7.
  const pct =
    goalCents && goalCents > 0
      ? Math.min(100, (raisedCents / goalCents) * 100)
      : null;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* What is this */}
        <h1 className="text-xl font-bold leading-tight">{title}</h1>
        {causeDescription && (
          /* The reason a stranger gives. Someone arriving from a group text
             reads this before anything else, so it is body copy, not the
             metadata line it used to be under the title. */
          <p className="text-base text-gray-200 mt-2.5 leading-relaxed">
            {causeDescription}
          </p>
        )}

        {/* Price. ONE PRICE, NEVER TWO.

            While early bird is live this is a promotion: what you pay now, and
            the date it ends. THE REGULAR PRICE IS NOT SHOWN. It used to read
            "Through Sep 27 · then $50", which asks someone deciding whether to
            buy today to do arithmetic about a price that is not on offer, and
            puts the larger number on the screen beside the one they would pay.
            The host still sees both, through priceScheduleLabel() — she is the
            one who has to plan around the changeover.

            After the changeover there is one price again and no early-bird
            framing at all. `price` comes from publicPriceDisplay() on the
            server, which calls the same predicate the checkout charges on. */}
        {price.earlyBird ? (
          <div className="mt-3 rounded-lg border border-green-800/60 bg-green-950/30 px-3.5 py-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-green-300">
                Early bird
              </span>
              <span className="text-xl font-bold text-white tabular-nums">
                {money(price.amountCents)}
              </span>
              <span className="text-sm text-gray-400">per {u.one}</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Through {shortDate(price.deadline, timezone)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-500 mt-2">
            {money(price.amountCents)} per {u.one}
          </p>
        )}
        {hostName && (
          <p className="text-xs text-gray-600 mt-2">hosted by {hostName}</p>
        )}

        {/* How's it going. `raised` is a sum of pricePaidCents, never a count
            multiplied by a price — invariant 43. The qualifier matters: a bare
            number reads as final. */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xl font-bold tabular-nums">
              {money(raisedCents)}
            </span>
            <span className="text-sm text-gray-500">
              {goalCents ? <>raised of {money(goalCents)}</> : <>raised</>}
            </span>
          </div>
          {pct !== null && (
            <div className="mt-2 h-2.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        {/* NO STATE COUNTS. Money doc §10: the public board shows two numbers,
            and a count of squares beside a dollar figure invites a
            multiplication that will not reconcile. It did not reconcile here —
            "$29 raised · 68 tickets left" on a 100-ticket $1 board — and it was
            visible to anyone with the link. The raised amount, the goal and the
            progress bar stay; they are the two numbers.

            `openCount` is still a PROP and still load-bearing: it disables the
            purchase CTA at zero and promotes Donate to primary. Only the
            display is gone. */}

        {/* DONATION-ONLY CARD RETURN. Same first line as every other successful
            submit state; what happened is the line under it, never mixed into
            it. A pending row says so plainly rather than claiming a payment
            that has not confirmed - the poll above is refreshing, and if the
            webhook never lands the contributor is not told a falsehood. */}
        {donation && (
          <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 mt-5">
            <p className="text-sm font-medium text-green-100">
              {CONTRIBUTION_THANKS}
            </p>
            <p className="text-sm text-green-200/80 mt-1">
              {donation.settled ? "Payment received" : "Payment is still processing"}
            </p>

            {/* Offered only when a real token exists. A donor who ticked the
                box but whose payment has not confirmed sees nothing here
                rather than a control that 404s - the same rule the ticket
                confirmation follows. NO PASS, NO GRANT: this is a sign-up
                sheet, not admission. */}
            {donation.signupUrl && (
              <div className="mt-3 border-t border-green-800/40 pt-3">
                <a
                  href={donation.signupUrl}
                  className="inline-block rounded-lg bg-green-200 px-3 py-2 text-sm font-medium text-gray-950 hover:bg-green-100 transition-colors"
                >
                  Sign up to volunteer
                </a>
              </div>
            )}
          </div>
        )}

        {/* Confirmation — v2 §6. Not a generic success page.
            Never says "ticket" on a no-prize board: ticket to what? The word
            only means something when there is a drawing, and Phase A has none. */}
        {confirmation && confirmation.positions.length > 0 && (
          <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 mt-5">
            {/* The "🎉 Square #4 is yours." line is deliberately absent. A
                fundraiser contributor bought a ticket, not a grid position; the
                square number names an internal detail they never chose and
                cannot use. Game Day keeps its own confirmation copy. */}
            {/* THE SAME FIRST LINE AS EVERY OTHER SUCCESSFUL SUBMIT STATE.
                Four of them exist across three components; the sentence is a
                constant so they cannot drift apart. What actually happened is
                the line underneath, never mixed into the thank-you. */}
            <p className="text-sm font-medium text-green-100">
              {CONTRIBUTION_THANKS}
            </p>
            <p className="text-sm text-green-200/80 mt-1">Payment received</p>
            <p className="text-sm text-green-200/80 mt-1">
              {confirmation.positions.length}{" "}
              {confirmation.positions.length === 1 ? u.one : u.many} confirmed
            </p>

            {/* Entry lines only on a prize board — "Entry #23" means nothing
                when there is no drawing. Gated on the prize, not board type. */}
            {hasPrize && (
              <p className="text-sm text-green-200/80 mt-2">
                {confirmation.positions.length === 1 ? "Entry" : "Entries"}{" "}
                {confirmation.positions.map((p) => `#${p}`).join(" · ")}
              </p>
            )}
            {confirmation.hasEvent && confirmation.admissionPasses > 0 && (
              <p className="text-sm text-green-200/80 mt-1">
                {confirmation.admissionPasses}{" "}
                {confirmation.admissionPasses === 1 ? ADMISSION.One : ADMISSION.Many}
                {confirmation.passesUrl && (
                  <>
                    {" · "}
                    <a
                      href={confirmation.passesUrl}
                      className="underline underline-offset-4 hover:text-green-100"
                    >
                      View your passes
                    </a>
                  </>
                )}
              </p>
            )}
            {/* Sign-up addendum SS5, as amended: the supporter chooses to go.
                The button carries the same gate the redirect did — see the
                comment on the removed effect above. Only a supporter who
                ticked the help box sees any of this. */}
            {confirmation.wantsToHelp && (
              <div className="mt-3 border-t border-green-800/40 pt-3">
                {confirmation.signupUrl ? (
                  <a
                    href={confirmation.signupUrl}
                    className="inline-block rounded-lg bg-green-200 px-3 py-2 text-sm font-medium text-gray-950 hover:bg-green-100 transition-colors"
                  >
                    Sign up to volunteer
                  </a>
                ) : pollExhausted ? (
                  /* Confirmation has not landed inside the twenty-second
                     budget. Do NOT offer a link: there is no token yet,
                     because there is no active supporter yet, and a CTA that
                     404s is worse than a sentence that tells the truth. */
                  <p className="text-sm text-green-200/80">
                    We&apos;ll email your sign-up link as soon as your payment
                    finishes processing.
                  </p>
                ) : (
                  <p className="text-sm text-green-200/80">
                    Setting up your sign-up link…
                  </p>
                )}
              </div>
            )}

            {/* THE ONLY EXIT. Until now the browser back button was the only
                way off this page, and while the redirect existed that did not
                work either. A plain link, always present, whether or not the
                supporter volunteered. Href drops the success query params, so
                the confirmation does not rebuild on arrival. */}
            <a
              href={`/board/${slug}`}
              className="inline-block mt-3 text-sm underline underline-offset-4 text-green-200/70 hover:text-green-100"
            >
              Back to the fundraiser
            </a>
          </div>
        )}

        {hold && !holdResolvedByServer && (
          <div className="mt-5">
            <HoldTimer
              expiresAt={hold.holdExpiresAt}
              heldStatuses={heldStatuses}
              onReclaim={() => {
                setReclaim(hold.squareIds);
                clearHold();
                setClaiming(true);
              }}
              onDismiss={clearHold}
              unit={{ one: u.one, many: u.many }}
              actions={
                hold.email
                  ? {
                      busy: holdBusy,
                      onResume: () => holdAction("resume"),
                      onSwitchToCash: () => holdAction("cash"),
                      onRelease: () => holdAction("release"),
                      cashAvailable: cashModeEnabled,
                    }
                  : undefined
              }
            />
            {holdError && (
              <p className="text-sm text-red-400 mt-2" role="alert">
                {holdError}
              </p>
            )}
          </div>
        )}

        {/* PURCHASE UI IS HIDDEN IN THE CONFIRMATION STATE. She has just done
            all of this: "Purchase tickets — $1" sitting directly beneath her
            receipt is an invitation to buy again by accident, and "How it
            works" explains a thing she has finished doing.

            Not a second exit — "Back to the fundraiser" in the confirmation
            panel returns to the normal board with everything restored, and
            adding a purchase entry point here would be a second one. */}
        {!showingConfirmation && (
          <>
        {/* What do I do */}
        {status !== "open" ? (
          <div className="mt-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
            <p className="text-sm font-medium">This campaign has closed.</p>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              Thank you to everyone who contributed.
              {hasEvent
                ? " Tickets already issued still work at the event."
                : ""}
            </p>
          </div>
        ) : (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setClaiming(true)}
            disabled={openCount === 0}
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {openCount === 0 ? `Every ${u.one} is claimed` : ctaLabel}
          </button>

          {/* Donate — donations SS12. Subordinate while squares are open, and
              PRIMARY the moment open squares reach zero: a full board that
              can still take money is the difference between a finished
              fundraiser and one that keeps going. */}
          <button
            type="button"
            onClick={() => setDonating(true)}
            className={
              openCount === 0
                ? "mt-2 w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 transition-colors"
                : "mt-2 w-full rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm font-medium text-gray-200 hover:border-gray-700 transition-colors"
            }
          >
            Donate instead
          </button>
        </div>
        )}

        {/* NO GRID. A contributor buys a QUANTITY; the server assigns the
            positions. The 10x10 grid was the last thing on this page still
            teaching the square-picking mental model the fundraiser experience
            exists to hide — even read-only, a grid of numbered cells invites
            "which one do I get?", which is a question this product has no
            answer to and does not want asked.

            Availability still has to be legible, and it is: the header carries
            the raised total, the price, the early-bird schedule, the supporter
            count and how many are left. Those are the facts a grid was
            conveying; the grid was the least direct way to convey them.

            GAME DAY IS UNAFFECTED. It renders player-board.tsx, not this
            component, and its grid is the product. */}

        <div className="mt-6">
        </div>
          </>
        )}

        {donating && (
          <DonateSheet
            slug={slug}
            cashModeEnabled={cashModeEnabled}
            stripeConnected={stripeConnected}
            handles={handles}
            // Both, or the box collects an intention nothing can act on.
            canVolunteer={hasEvent && signupSheetExists}
            onClose={() => setDonating(false)}
          />
        )}

        {claiming && (
          <ClaimSheet
            openSquares={squares
              .filter((sq) => sq.paymentStatus === "open")
              .map((sq) => ({ squareId: sq.squareId, position: sq.position }))}
            priceCents={currentPrice}
            hasEvent={hasEvent}
            hasPrize={hasPrize}
            cashModeEnabled={cashModeEnabled}
            stripeConnected={stripeConnected}
            handles={handles}
            slug={slug}
            signupSheetExists={signupSheetExists}
            initialPicked={reclaim?.filter((id) =>
              squares.some(
                (sq) => sq.squareId === id && sq.paymentStatus === "open"
              )
            )}
            onClose={() => {
              setClaiming(false);
              setReclaim(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}
