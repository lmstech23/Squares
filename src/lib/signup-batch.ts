// The batched sign-up save — shapes shared by the route and the sheet, and the
// one piece of client logic worth testing on its own.
//
// A supporter picks everything she wants, then saves once. Nothing commits on
// change. The batch is a TRANSPORT change and nothing more: signups.ts remains
// the sole writer, setTargetQuantity is called once per slot, and every
// capacity, uniqueness and all-or-nothing-within-a-slot rule is untouched.
//
// PER-SLOT ATOMICITY IS INHERITED, NOT ADDED. setTargetQuantity already opens
// its own transaction and holds SELECT … FOR UPDATE on the slot row for its
// duration, so calling it N times sequentially gives exactly the isolation the
// batch needs: one slot filling up rolls back that slot and nothing else.
// Wrapping the loop in a transaction would be actively wrong — it would roll
// back the saves that succeeded.

/** One requested change. TARGET TOTAL, never a delta. */
export interface BatchChange {
  slotId: string;
  target: number;
}

export type BatchResult =
  | { slotId: string; ok: true; quantity: number; changed: boolean }
  | {
      slotId: string;
      ok: false;
      reason: "capacity" | "closed" | "not_active" | "invalid_target" | "error";
      error: string;
      /** Capacity conflicts only: what she may hold after this failure. */
      available?: number;
      yourCurrent?: number;
      maxTarget?: number;
    };

export interface BatchResponse {
  /** Every item committed. FALSE IS NOT AN HTTP ERROR — see below. */
  ok: boolean;
  results: BatchResult[];
}

/**
 * Which slots differ from what the server says is committed.
 *
 * `drafts` holds only what the supporter has touched; anything absent is
 * unchanged by definition. A draft equal to `yourCurrent` is a fidget that
 * ended where it started and is not sent — setTargetQuantity would compute a
 * zero delta and write no log row anyway, but not sending it keeps the batch
 * honest about what it is asking for.
 */
export function dirtyChanges(
  slots: { id: string; yourCurrent: number }[],
  drafts: Record<string, number>
): BatchChange[] {
  const out: BatchChange[] = [];
  for (const s of slots) {
    const target = drafts[s.id];
    if (target === undefined || target === s.yourCurrent) continue;
    out.push({ slotId: s.id, target });
  }
  return out;
}

export interface AppliedBatch {
  drafts: Record<string, number>;
  errors: Record<string, string>;
  savedCount: number;
  failedCount: number;
}

/**
 * Fold a batch response back into client state.
 *
 * SUCCESS CLEARS THE DRAFT — the server is now the truth for that slot, and a
 * leftover draft equal to the new `yourCurrent` would render as unsaved work.
 *
 * FAILURE KEEPS IT. She asked for something and did not get it; wiping her
 * selection would make her rebuild it, and silently lowering it would commit a
 * number she never chose. The draft is CLAMPED to the `maxTarget` from THIS
 * response so the re-save is achievable.
 *
 * THE CLAMP MUST USE THIS RESPONSE, NEVER A REMEMBERED ONE. Availability moves
 * under her between attempts: a slot that could take 2 a moment ago may take 1
 * now, and clamping to the stale ceiling would put her straight back into the
 * same conflict. That is why the clamp lives here, against the results just
 * received, rather than being derived from anything held in component state.
 */
export function applyBatchResults(
  drafts: Record<string, number>,
  results: BatchResult[]
): AppliedBatch {
  const nextDrafts = { ...drafts };
  const errors: Record<string, string> = {};
  let savedCount = 0;
  let failedCount = 0;

  for (const r of results) {
    if (r.ok) {
      delete nextDrafts[r.slotId];
      savedCount++;
      continue;
    }
    failedCount++;
    errors[r.slotId] = r.error;
    if (typeof r.maxTarget === "number") {
      const asked = nextDrafts[r.slotId];
      nextDrafts[r.slotId] = Math.min(asked ?? r.maxTarget, r.maxTarget);
    }
  }

  return { drafts: nextDrafts, errors, savedCount, failedCount };
}

/**
 * The line above the Save button.
 *
 * Never "Saved!" when something failed — a supporter who reads that and walks
 * away believes she is signed up for a shift nobody is covering.
 */
export function batchSummary(applied: AppliedBatch): string | null {
  const { savedCount, failedCount } = applied;
  if (failedCount === 0) return null;
  if (savedCount === 0) {
    return failedCount === 1
      ? "That couldn't be saved — see below."
      : "Nothing could be saved — see below.";
  }
  return `Saved ${savedCount} of ${savedCount + failedCount}. See the ${
    failedCount === 1 ? "one below" : "ones below"
  }.`;
}
