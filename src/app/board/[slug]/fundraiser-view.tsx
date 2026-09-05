"use client";

import { priceScheduleLabel } from "@/lib/claim-price";
import { purchaseUnit, ADMISSION } from "@/lib/board-vocabulary";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ClaimSheet from "./claim-sheet";
import DonateSheet from "./donate-sheet";
import HoldTimer from "./hold-timer";
import HowItWorks from "./how-it-works";

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
  squarePrice: number;
  earlyBirdPriceCents: number | null;
  earlyBirdEndsAt: Date | null;
  /// Decided by the caller, not here: "is the changeover still ahead" depends
  /// on the current time, which makes it impure inside render.
  earlyBirdActive: boolean;
  timezone: string | null;
  raisedCents: number;
  /// Null = no goal set. No bar, no denominator — v2 §7.
  goalCents: number | null;
  supporterCount: number;
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
  squarePrice,
  earlyBirdPriceCents,
  earlyBirdEndsAt,
  earlyBirdActive,
  timezone,
  raisedCents,
  goalCents,
  supporterCount,
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

  useEffect(() => {
    if (!confirmation || purchaseSettled) return;
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
  }, [confirmation, purchaseSettled, router]);

  // VOLUNTEER REDIRECT — sign-up addendum §5.
  //
  // Fires only once the server has minted a token, which it does only for a
  // CONFIRMED supporter. So this cannot race the webhook: while the purchase
  // is pending there is no url to navigate to, the poll above keeps refreshing,
  // and if twenty seconds pass without one the fallback below takes over.
  // DERIVED, not state. Whether we are navigating is entirely a function of
  // what the server sent — a token means go — so holding it in state would be
  // a second copy of a fact that already exists, kept in sync by an effect.
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
  // The schedule line renders only while the early bird price is still in
  // effect. Once the changeover has passed there is one price again, and
  // saying "through Sept 15, then $30" about a date in the past is noise.
  const showSchedule =
    earlyBirdActive && earlyBirdPriceCents != null && earlyBirdEndsAt != null;

  const currentPrice = showSchedule ? earlyBirdPriceCents : squarePrice;

  // Early-bird promotion, from the SAME predicate that decides what is charged
  // (claim-price.ts). Keying a badge on `earlyBirdPriceCents != null` alone
  // would keep advertising the discount after the window closed.
  // `earlyBirdActive` is the PROP, decided by the caller from
  // earlyBirdActive() in claim-price.ts — the same predicate
  // currentPriceCents() charges on. The view stays pure and does not re-derive
  // "is the window still open" from a timestamp.
  const showEarlyBird =
    earlyBirdActive && earlyBirdPriceCents != null && earlyBirdEndsAt != null;

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

        {/* Price. When an early-bird window is OPEN this is a promotion: the
            price you pay now is the headline, the deadline and the regular
            price are the fine print underneath.

            `showEarlyBird` comes from earlyBirdActive() in claim-price.ts — the
            same predicate currentPriceCents() charges on. A badge keyed only on
            earlyBirdPriceCents being set would keep advertising a discount
            after the window closed. */}
        {showEarlyBird ? (
          <div className="mt-3 rounded-lg border border-green-800/60 bg-green-950/30 px-3.5 py-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-green-300">
                Early bird
              </span>
              <span className="text-xl font-bold text-white tabular-nums">
                {money(earlyBirdPriceCents!)}
              </span>
              <span className="text-sm text-gray-400">per {u.one}</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Through {shortDate(earlyBirdEndsAt!, timezone)} · then{" "}
              {money(squarePrice)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-500 mt-2">
            {priceScheduleLabel(
              { squarePrice, earlyBirdPriceCents, earlyBirdEndsAt, timezone },
              new Date(),
              u.one
            )}
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

        {/* What's the fun — supporter momentum on a no-prize board. Phase A
            renders no prize pool line at all. */}
        <p className="text-sm text-gray-400 mt-3">
          {supporterCount} {supporterCount === 1 ? "supporter" : "supporters"} so
          far
          <span className="text-gray-600"> · </span>
          {openCount} {openCount === 1 ? u.one : u.many} left
        </p>

        {/* Confirmation — v2 §6. Not a generic success page.
            Never says "ticket" on a no-prize board: ticket to what? The word
            only means something when there is a drawing, and Phase A has none. */}
        {confirmation && confirmation.positions.length > 0 && (
          <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 mt-5">
            {/* The "🎉 Square #4 is yours." line is deliberately absent. A
                fundraiser contributor bought a ticket, not a grid position; the
                square number names an internal detail they never chose and
                cannot use. Game Day keeps its own confirmation copy. */}
            {/* THE HEADLINE. This block had none: the old "Square #4 is yours"
                line was removed because it said "square", and nothing replaced
                it. On a no-prize board with donated admissions that left a
                green box whose only sentence was a nudge about the total — a
                contributor came back from paying and was told nothing about
                their payment. Say it plainly, first. */}
            <p className="text-sm font-medium text-green-100">
              Payment received — thank you.
            </p>
            <p className="text-sm text-green-200/80 mt-1">
              {confirmation.positions.length}{" "}
              {confirmation.positions.length === 1 ? u.one : u.many} confirmed.
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
            <p className="text-xs text-green-200/60 mt-2">
              You just moved this{" "}
              {money(currentPrice * confirmation.positions.length)} closer.
            </p>

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
          <HowItWorks hasEvent={hasEvent} hasPrize={hasPrize} />
        </div>

        {donating && (
          <DonateSheet
            slug={slug}
            cashModeEnabled={cashModeEnabled}
            stripeConnected={stripeConnected}
            handles={handles}
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
