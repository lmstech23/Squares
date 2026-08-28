"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Fundraiser create form — fundraiser-board-v2.md §5.
//
// Not on this form: sport, teams, periods, payout split grid, host cut.
// If any of those render, the form is wrong (v2 §5).
//
// Prize fields do not render in Phase A. prizePoolPercent stays 0 and the
// server never accepts it — a host must not be able to switch on a drawing
// that has nothing behind it (v2 §16).

const SQUARE_COUNTS = [25, 50, 75, 100];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.some((t) => t.value === tz) ? tz : "America/New_York";
  } catch {
    return "America/New_York";
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

interface Props {
  isCashHost: boolean;
  onBack: () => void;
}

export default function FundraiserForm({ isCashHost, onBack }: Props) {
  const router = useRouter();

  const [gameName, setGameName] = useState("");
  const [causeDescription, setCauseDescription] = useState("");
  const [totalSquares, setTotalSquares] = useState(100);
  const [price, setPrice] = useState("");
  const [earlyBirdPrice, setEarlyBirdPrice] = useState("");
  const [earlyBirdEndsAt, setEarlyBirdEndsAt] = useState("");
  const [campaignEndsAt, setCampaignEndsAt] = useState("");
  const [timezone, setTimezone] = useState(detectTimezone);
  const [cashHoldDays, setCashHoldDays] = useState("7");

  const [hasEvent, setHasEvent] = useState(false);
  const [eventName, setEventName] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventVenue, setEventVenue] = useState("");
  const [maxAttendees, setMaxAttendees] = useState("4");

  const [hostVenmo, setHostVenmo] = useState("");
  const [hostZelle, setHostZelle] = useState("");
  const [hostCashapp, setHostCashapp] = useState("");
  const [hostPaypal, setHostPaypal] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const priceCents = Math.round(parseFloat(price || "0") * 100);
  const earlyCents = earlyBirdPrice
    ? Math.round(parseFloat(earlyBirdPrice) * 100)
    : null;

  // Live preview — v2 §5. A range when early bird is set, because the total
  // depends on when squares sell: every square early is the low end, none
  // sold early is the high end. Flat pricing collapses it to one figure.
  const showPreview = priceCents >= 100;
  const highTotal = priceCents * totalSquares;
  const lowTotal =
    earlyCents && earlyCents < priceCents ? earlyCents * totalSquares : highTotal;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!gameName.trim()) {
      setError("Tell people what you're raising money for.");
      return;
    }
    if (!priceCents || priceCents < 100) {
      setError("Contribution per square must be at least $1.");
      return;
    }
    if (earlyBirdPrice) {
      if (!earlyCents || earlyCents < 100) {
        setError("Early bird price must be at least $1.");
        return;
      }
      if (earlyCents >= priceCents) {
        setError("Early bird price must be below the standard price.");
        return;
      }
      if (!earlyBirdEndsAt) {
        setError("Set a date for the early bird price to end.");
        return;
      }
    }
    if (!campaignEndsAt) {
      setError("A campaign close date is required.");
      return;
    }
    if (hasEvent && !eventStartsAt) {
      setError("An event date and time is required.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardType: "fundraiser",
          gameName: gameName.trim(),
          causeDescription: causeDescription.trim() || null,
          totalSquares,
          squarePrice: priceCents,
          timezone,
          campaignEndsAt,
          earlyBirdPriceCents: earlyCents,
          earlyBirdEndsAt: earlyBirdEndsAt || null,
          cashHoldDays: parseInt(cashHoldDays, 10) || 7,
          hasEvent,
          eventName: eventName.trim() || null,
          eventStartsAt,
          eventVenue: eventVenue.trim() || null,
          maxAttendeesPerSupporter: parseInt(maxAttendees, 10) || 4,
          hostVenmo: hostVenmo.trim() || null,
          hostZelle: hostZelle.trim() || null,
          hostCashapp: hostCashapp.trim() || null,
          hostPaypal: hostPaypal.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 && data.redirectTo) {
          router.push(data.redirectTo);
          return;
        }
        setError(data.error || "Failed to create board.");
        setLoading(false);
        return;
      }
      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-xs">
        <span>
          <span className="text-gray-500">Board type:</span>{" "}
          <span className="font-medium">Fundraiser</span>
        </span>
        <button
          type="button"
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors"
        >
          Change
        </button>
      </div>

      {/* --- The cause --- */}
      <div>
        <label htmlFor="gameName" className={labelClass}>
          What are you raising money for?
        </label>
        <input
          id="gameName"
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="Hampton Homecoming Tailgate"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="causeDescription" className={labelClass}>
          Tell people what it&apos;s for{" "}
          <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          id="causeDescription"
          value={causeDescription}
          onChange={(e) => setCauseDescription(e.target.value)}
          rows={2}
          placeholder="Food, tents, and music for the class of 2016 tailgate."
          className={inputClass}
        />
      </div>

      {/* --- Squares and price --- */}
      <div>
        <span className={labelClass}>Number of squares</span>
        <div className="grid grid-cols-4 gap-2">
          {SQUARE_COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setTotalSquares(n)}
              className={`rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                totalSquares === n
                  ? "border-green-500 bg-green-950/20 text-white"
                  : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="squarePrice" className={labelClass}>
          Contribution per square
        </label>
        <input
          id="squarePrice"
          type="number"
          min="1"
          step="1"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="30"
          className={inputClass}
        />
      </div>

      {/* --- Early bird — money doc §8B --- */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-4">
        <div>
          <label htmlFor="earlyBirdPrice" className={labelClass}>
            Early bird price <span className="text-gray-600">(optional)</span>
          </label>
          <input
            id="earlyBirdPrice"
            type="number"
            min="1"
            step="1"
            inputMode="decimal"
            value={earlyBirdPrice}
            onChange={(e) => setEarlyBirdPrice(e.target.value)}
            placeholder="25"
            className={inputClass}
          />
          <p className="text-xs text-gray-600 mt-1.5">
            Must be below the standard price. The price is fixed when a square
            is claimed, not when payment lands.
          </p>
        </div>

        {earlyBirdPrice && (
          <div>
            <label htmlFor="earlyBirdEndsAt" className={labelClass}>
              Early bird ends
            </label>
            <input
              id="earlyBirdEndsAt"
              type="datetime-local"
              value={earlyBirdEndsAt}
              onChange={(e) => setEarlyBirdEndsAt(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
      </div>

      {/* --- Dates. Independent of one another; no validation relates them. --- */}
      <div>
        <label htmlFor="campaignEndsAt" className={labelClass}>
          Campaign closes
        </label>
        <input
          id="campaignEndsAt"
          type="datetime-local"
          value={campaignEndsAt}
          onChange={(e) => setCampaignEndsAt(e.target.value)}
          className={inputClass}
        />
        <p className="text-xs text-gray-600 mt-1.5">
          Cash reservations must be confirmed before this date.
        </p>
      </div>

      <div>
        <label htmlFor="timezone" className={labelClass}>
          Timezone
        </label>
        <select
          id="timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className={inputClass}
        >
          {TIMEZONES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {isCashHost && (
        <div>
          <label htmlFor="cashHoldDays" className={labelClass}>
            Cash hold window
          </label>
          <input
            id="cashHoldDays"
            type="number"
            min="1"
            max="60"
            value={cashHoldDays}
            onChange={(e) => setCashHoldDays(e.target.value)}
            className={inputClass}
          />
          <p className="text-xs text-gray-600 mt-1.5">
            Days a reservation is held before you confirm it. Capped at
            campaign close.
          </p>
        </div>
      )}

      {/* --- Optional event block — v2 §5 --- */}
      <div className="rounded-lg border border-gray-800 p-4">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={hasEvent}
            onChange={(e) => setHasEvent(e.target.checked)}
            className="mt-0.5 accent-green-500"
          />
          <span>
            <span className="block text-sm">
              This fundraiser includes event admission
            </span>
            <span className="block text-xs text-gray-600 mt-0.5">
              Contributors can bring people to an event. Set the terms now —
              they lock once the first contribution is confirmed.
            </span>
          </span>
        </label>

        {hasEvent && (
          <div className="space-y-4 mt-4 pt-4 border-t border-gray-800">
            <div>
              <label htmlFor="eventName" className={labelClass}>
                Event name{" "}
                <span className="text-gray-600">
                  (defaults to the campaign title)
                </span>
              </label>
              <input
                id="eventName"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder={gameName || "Homecoming Tailgate"}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="eventStartsAt" className={labelClass}>
                Date and time
              </label>
              <input
                id="eventStartsAt"
                type="datetime-local"
                value={eventStartsAt}
                onChange={(e) => setEventStartsAt(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="eventVenue" className={labelClass}>
                Venue <span className="text-gray-600">(optional)</span>
              </label>
              <input
                id="eventVenue"
                value={eventVenue}
                onChange={(e) => setEventVenue(e.target.value)}
                placeholder="Armstrong Stadium, Lot C"
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="maxAttendees" className={labelClass}>
                Max attendees per supporter
              </label>
              <input
                id="maxAttendees"
                type="number"
                min="1"
                max="10"
                value={maxAttendees}
                onChange={(e) => setMaxAttendees(e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-gray-600 mt-1.5">
                Per person, not per square. Someone who contributes twice draws
                from the same allowance.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* --- How contributors pay you --- */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-4">
        <div>
          <span className="block text-sm">How contributors pay you</span>
          <span className="block text-xs text-gray-600 mt-0.5">
            Optional. Shown to anyone paying by cash or direct transfer.
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="hostVenmo" className={labelClass}>
              Venmo
            </label>
            <input
              id="hostVenmo"
              value={hostVenmo}
              onChange={(e) => setHostVenmo(e.target.value)}
              placeholder="@handle"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostCashapp" className={labelClass}>
              Cash App
            </label>
            <input
              id="hostCashapp"
              value={hostCashapp}
              onChange={(e) => setHostCashapp(e.target.value)}
              placeholder="$handle"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostZelle" className={labelClass}>
              Zelle
            </label>
            <input
              id="hostZelle"
              value={hostZelle}
              onChange={(e) => setHostZelle(e.target.value)}
              placeholder="email or phone"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostPaypal" className={labelClass}>
              PayPal
            </label>
            <input
              id="hostPaypal"
              value={hostPaypal}
              onChange={(e) => setHostPaypal(e.target.value)}
              placeholder="paypal.me/handle"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* --- Live preview --- */}
      {showPreview && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <p className="text-sm">
            If all {totalSquares} squares fill you raise{" "}
            <span className="font-semibold">
              {lowTotal === highTotal
                ? money(highTotal)
                : `${money(lowTotal)} – ${money(highTotal)}`}
            </span>
          </p>
          {lowTotal !== highTotal && (
            <p className="text-xs text-gray-600 mt-1.5">
              A range because the total depends on when squares sell — the low
              end is every square at the early bird price.
            </p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create fundraiser"}
      </button>
    </form>
  );
}
