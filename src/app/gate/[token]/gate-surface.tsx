"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ADMISSION } from "@/lib/board-vocabulary";

// The gate — fundraiser-board-v2.md §6B.
//
// SEARCH IS THE PRIMARY PATH, not the fallback. Every direct-payment
// contributor confirmed while standing at the gate has no QR yet, because none
// existed until the host tapped confirm. So the search field is visible at all
// times and never sits behind a failed camera prompt.
//
// The scanner is opt-in: permission is requested on an explicit tap, never on
// page load. Denial, unavailability and outright failure all fall through to
// search, which is already on screen — there is no dead end.
//
// Result states flood the viewport with one word, readable at arm's length in
// midday glare. Roster rows are 64px minimum: thumb targets, not cursor
// targets.

export interface RosterEntry {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  total: number;
  used: number;
  passes: { id: string; used: boolean; label: string | null }[];
}

interface Props {
  token: string;
  eventName: string;
  staffLabel: string;
  roster: RosterEntry[];
}

type Result =
  | { kind: "ok"; name: string; undone?: boolean; passId?: string }
  | { kind: "error"; message: string; duplicate?: boolean }
  | null;

export default function GateSurface({
  token,
  eventName,
  staffLabel,
  roster: initialRoster,
}: Props) {
  const [roster, setRoster] = useState(initialRoster);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);

  const scannerRef = useRef<{ stop: () => Promise<void> } | null>(null);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);

  const q = query.trim().toLowerCase();
  const visible = q
    ? roster.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q) ||
          (r.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "")) ||
          r.passes.some((p) => (p.label ?? "").toLowerCase().includes(q))
      )
    : roster;

  const post = useCallback(
    async (
      body: Record<string, unknown>
    ): Promise<{ ok: boolean; data: Record<string, unknown> }> => {
      const res = await fetch(`/api/gate/${token}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, data: await res.json() };
    },
    [token]
  );

  /** Optimistically move counts so the next person in line sees the truth. */
  function applyLocal(passId: string, used: boolean) {
    setRoster((prev) =>
      prev.map((r) =>
        r.passes.some((p) => p.id === passId)
          ? {
              ...r,
              used: r.used + (used ? 1 : -1),
              passes: r.passes.map((p) => (p.id === passId ? { ...p, used } : p)),
            }
          : r
      )
    );
  }

  async function checkIn(passId: string, name: string) {
    setBusy(true);
    const { ok, data } = await post({ passId, action: "check_in" });
    setBusy(false);
    if (!ok) {
      setResult({
        kind: "error",
        message: String(data.error ?? "Could not check in."),
        duplicate: Boolean(data.duplicate),
      });
      return;
    }
    applyLocal(passId, true);
    setResult({ kind: "ok", name, passId });
  }

  async function undo(passId: string, name: string) {
    setBusy(true);
    const { ok, data } = await post({ passId, action: "undo" });
    setBusy(false);
    if (!ok) {
      setResult({ kind: "error", message: String(data.error ?? "Could not undo.") });
      return;
    }
    applyLocal(passId, false);
    setResult({ kind: "ok", name, undone: true });
  }

  const onScan = useCallback(
    async (value: string) => {
      // Continuous scan re-reads the same code many times a second. Ignore a
      // repeat of the same value within two seconds so one ticket produces one
      // result, not a strobe of them.
      const now = Date.now();
      if (
        lastScanRef.current &&
        lastScanRef.current.value === value &&
        now - lastScanRef.current.at < 2000
      ) {
        return;
      }
      lastScanRef.current = { value, at: now };

      const { ok, data } = await post({ passToken: value, action: "check_in" });
      const supporter = data.supporter as { name?: string } | undefined;

      if (!ok) {
        setResult({
          kind: "error",
          message: String(data.error ?? "Not a valid ticket."),
          duplicate: Boolean(data.duplicate),
        });
        return;
      }
      setResult({ kind: "ok", name: supporter?.name ?? "Checked in" });
    },
    [post]
  );

  async function startScanning() {
    setCameraNote(null);
    setScanning(true);

    try {
      // Loaded on demand. The library is large and most of a shift is search,
      // so a staff member who never scans never downloads it.
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("gate-reader");
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decoded) => void onScan(decoded),
        () => {
          // Per-frame decode misses are normal and constant. Silence.
        }
      );
    } catch {
      // Denied, unavailable, or blocked. The most common cause is an iOS
      // in-app browser — Facebook and Instagram block getUserMedia outright,
      // and the staff member has no way to know that from a silent failure.
      setScanning(false);
      scannerRef.current = null;
      setCameraNote(
        "The camera isn't available here. If you opened this from Facebook, Instagram, or another app, open it in Safari or Chrome instead. Search by name below — it works the same."
      );
    }
  }

  async function stopScanning() {
    try {
      await scannerRef.current?.stop();
    } catch {
      // Already stopped.
    }
    scannerRef.current = null;
    setScanning(false);
  }

  useEffect(() => {
    return () => {
      void scannerRef.current?.stop().catch(() => {});
    };
  }, []);

  // Full-viewport result flood. One word, readable at arm's length.
  if (result) {
    const good = result.kind === "ok";
    return (
      <div
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center ${
          good ? "bg-green-600" : result.duplicate ? "bg-amber-500" : "bg-red-600"
        }`}
      >
        <p className="text-6xl font-bold text-white">
          {good ? (result.undone ? "UNDONE" : "IN") : result.duplicate ? "ALREADY" : "NO"}
        </p>
        <p className="text-xl text-white/90 mt-3 font-medium">
          {good ? result.name : result.message}
        </p>

        <div className="flex flex-col gap-2 mt-8 w-full max-w-xs">
          {good && !result.undone && result.passId && (
            <button
              type="button"
              onClick={() => {
                const passId = result.passId!;
                const name = result.name;
                setResult(null);
                void undo(passId, name);
              }}
              className="rounded-lg bg-white/20 px-4 py-3 text-base font-medium text-white"
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={() => setResult(null)}
            className="rounded-lg bg-white px-4 py-4 text-lg font-semibold text-gray-950"
          >
            Next person
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* No nav, no board branding, no menu. One screen. */}
      <div className="max-w-lg mx-auto px-4 py-5">
        <p className="text-sm text-gray-500">{eventName}</p>
        <p className="text-xs text-gray-600">{staffLabel}</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={scanning ? stopScanning : startScanning}
            className="flex-1 rounded-lg bg-white px-4 py-4 text-base font-semibold text-gray-950"
          >
            {scanning ? "Stop scanning" : "Start scanning"}
          </button>
        </div>

        <div
          id="gate-reader"
          className={`mt-3 overflow-hidden rounded-lg ${scanning ? "block" : "hidden"}`}
        />

        {cameraNote && (
          <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
            <p className="text-sm text-amber-200 leading-relaxed">{cameraNote}</p>
          </div>
        )}

        {/* Always visible, never behind the camera. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, or phone"
          className="mt-4 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-4 text-base text-white placeholder:text-gray-500 outline-none focus:border-gray-500"
        />

        <div className="mt-3 space-y-2 pb-10">
          {visible.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              {roster.length === 0
                ? "Nobody has tickets yet."
                : "No match. Check the spelling, or try their email."}
            </p>
          ) : (
            visible.map((r) => {
              const remaining = r.total - r.used;
              return (
                <div
                  key={r.id}
                  className="rounded-lg border border-gray-800 bg-gray-900 p-3"
                  style={{ minHeight: 64 }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-medium truncate">{r.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {r.email}
                        {r.phone ? ` · ${r.phone}` : ""}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {r.total} {r.total === 1 ? ADMISSION.one : ADMISSION.many} ·{" "}
                        {r.used} used · {remaining} remaining
                      </p>
                    </div>

                    {remaining > 0 ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const next = r.passes.find((p) => !p.used);
                          if (next) void checkIn(next.id, r.name);
                        }}
                        className="flex-shrink-0 rounded-lg bg-green-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
                        style={{ minHeight: 48 }}
                      >
                        Check in
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const last = [...r.passes].reverse().find((p) => p.used);
                          if (last) void undo(last.id, r.name);
                        }}
                        className="flex-shrink-0 rounded-lg border border-gray-700 px-4 text-sm text-gray-300 disabled:opacity-50"
                        style={{ minHeight: 48 }}
                      >
                        Undo
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
