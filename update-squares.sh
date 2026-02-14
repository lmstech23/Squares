#!/bin/bash
# ============================================================
# SQUARES — Period-Based Scoring Update
# Run from your repo root:  bash update-squares.sh
# Writes all 11 files, then tells you the git commands.
# ============================================================
set -e
echo "Updating 11 files for period-based scoring..."
echo ""

# --- prisma/schema.prisma ---
mkdir -p "$(dirname 'prisma/schema.prisma')"
cat > 'prisma/schema.prisma' << 'EOF_PRISMA_SCHEMA_PRISMA'
// ============================================================
// SQUARES â€” Prisma Schema
// 4 objects. No more. Locked before writing code.
// ============================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============================================================
// ENUMS
// ============================================================

enum BoardStatus {
  open
  closed
}

enum PaymentStatus {
  open     // available square (no checkout started)
  pending  // checkout created, TTL running
  paid     // checkout completed
  failed   // Stripe reported failure
  expired  // checkout session expired / TTL cleanup
}

/// Internal debugging only. Tracks WHY a square was released.
/// Null when square is open or paid.
enum ReleaseReason {
  expired // Checkout TTL hit â€” player never completed payment
  failed  // Stripe reported a payment failure
  manual  // Host or admin manually released the square
}

/// Determines scoring period structure for the board.
/// Drives payout slots, score entry UI, and winner highlighting.
///
/// PHASE 1 (March Madness): Default to "halves"
/// FUTURE  (CFB/NFL season): Host selects at board creation
enum PeriodType {
  halves   // College basketball, college football â†' H1, Final
  quarters // NFL, NBA, etc. â†' Q1, Q2, Q3, Q4
}

// ============================================================
// OBJECT 1: HOST
// ============================================================

model Host {
  id             String @id @default(uuid())
  supabaseUserId String @unique @map("supabase_user_id") // auth identity — never key on email
  name           String? // allow null during magic-link-first flow
  email          String? // display/contact only — NOT the identity key

  // Stripe Connect
  stripeAccountId      String?  @map("stripe_account_id")
  stripeChargesEnabled Boolean  @default(false) @map("stripe_charges_enabled")  // gate board creation on this
  stripePayoutsEnabled Boolean  @default(false) @map("stripe_payouts_enabled")  // updated via account.updated webhook

  createdAt DateTime @default(now()) @map("created_at")

  boards Board[]

  @@map("hosts")
}

// ============================================================
// OBJECT 2: BOARD
// ============================================================

model Board {
  boardId      String      @id @default(uuid()) @map("board_id")
  hostId       String      @map("host_id")
  gameName     String      @map("game_name")
  squarePrice  Int         @map("square_price") // cents (1000 = $10)
  totalSquares Int         @default(100) @map("total_squares")
  status       BoardStatus @default(open)
  createdAt    DateTime    @default(now()) @map("created_at")
  slug         String      @unique

  // Null until board closes, then arrays of [0-9] shuffled
  rowNumbers   Int[]?      @map("row_numbers")
  colNumbers   Int[]?      @map("col_numbers")

  // Team names — row team and column team for display + score entry
  teamRow String? @map("team_row") // e.g. "Duke"
  teamCol String? @map("team_col") // e.g. "Vermont"

  // --- Scoring period config ---
  // Drives payout structure keys, score entry UI, and winner highlighting.
  // Phase 1: default "halves" for March Madness
  // Future:  host picks at creation (quarters for NFL, halves for CFB)
  periodType   PeriodType @default(halves) @map("period_type")
  periodLabels String[]   @map("period_labels") // e.g. ["H1","Final"] or ["Q1","Q2","Q3","Q4"]
                                                  // No default — enforced at board creation:
                                                  //   halves  → ["H1","Final"]
                                                  //   quarters → ["Q1","Q2","Q3","Q4"]

  // Scores entered by host on game day. Parallel arrays indexed to periodLabels.
  // Store FULL scores (e.g. [35, 70]). Compute last digit in code: score % 10.
  scoresTeamA  Int[]?     @map("scores_team_a")  // e.g. [35, 70] for halves or [7, 14, 21, 28] for quarters
  scoresTeamB  Int[]?     @map("scores_team_b")

  // --- Smart fields ---
  payoutStructure        Json?     @map("payout_structure")
  maxSquaresPerPlayer    Int       @default(10) @map("max_squares_per_player")
  boardCloseTime         DateTime? @map("board_close_time")
  hostPayoutResponsible  Boolean   @default(true) @map("host_payout_responsible")
  currency               String    @default("USD")

  host    Host     @relation(fields: [hostId], references: [id])
  squares Square[]

  @@map("boards")
}

// ============================================================
// OBJECT 3: SQUARE
// ============================================================

model Square {
  squareId        String        @id @default(uuid()) @map("square_id")
  boardId         String        @map("board_id")
  position        Int           // 0–99. Row = position / 10, col = position % 10
  playerName      String?       @map("player_name")
  playerEmail     String?       @map("player_email")
  paymentStatus   PaymentStatus @default(open) @map("payment_status")
  stripePaymentId String?       @map("stripe_payment_id")

  checkoutExpiresAt DateTime?     @map("checkout_expires_at")
  releaseReason     ReleaseReason? @map("release_reason")

  board   Board             @relation(fields: [boardId], references: [boardId])
  payment PaymentReference?

  @@unique([boardId, position])
  @@index([boardId, playerEmail], map: "idx_squares_board_email") // fast lookup for max_squares_per_player enforcement
  @@map("squares")
}

// ============================================================
// OBJECT 4: PAYMENT REFERENCE
// ============================================================

model PaymentReference {
  paymentId       String   @id @default(uuid()) @map("payment_id")
  squareId        String   @unique @map("square_id")
  stripeSessionId String   @unique @map("stripe_session_id") // webhook idempotency â€” duplicate checkout.session.completed events hit unique constraint instead of double-writing
  amount          Int
  timestamp       DateTime @default(now())

  square Square @relation(fields: [squareId], references: [squareId])

  @@map("payment_references")
}
EOF_PRISMA_SCHEMA_PRISMA
echo "  ✓ prisma/schema.prisma"

# --- src/lib/winners.ts ---
mkdir -p "$(dirname 'src/lib/winners.ts')"
cat > 'src/lib/winners.ts' << 'EOF_SRC_LIB_WINNERS_TS'
export interface Winner {
  periodIndex: number;
  label: string; // e.g. "H1" or "Q2" or "Final"
  position: number; // 0-99
  colDigit: number;
  rowDigit: number;
  colScore: number;
  rowScore: number;
}

/**
 * Calculates winners for each period using:
 * last digit of TeamA score (columns) and TeamB score (rows),
 * and the board's shuffled 0–9 number assignments.
 *
 * teamA = col team (top)
 * teamB = row team (side)
 *
 * Stores FULL scores — computes last digit in code via % 10.
 */
export function calculateWinnersFromArrays(
  periodLabels: string[] | null,
  scoresTeamA: number[] | null,
  scoresTeamB: number[] | null,
  rowNumbers: number[] | null,
  colNumbers: number[] | null
): Winner[] {
  if (!periodLabels || !rowNumbers || !colNumbers) return [];
  if (rowNumbers.length !== 10 || colNumbers.length !== 10) return [];
  if (!scoresTeamA || !scoresTeamB) return [];

  const n = periodLabels.length;
  if (scoresTeamA.length !== n || scoresTeamB.length !== n) return [];

  const winners: Winner[] = [];

  for (let i = 0; i < n; i++) {
    const colScore = scoresTeamA[i];
    const rowScore = scoresTeamB[i];

    // Allow "not entered yet" by skipping nullish/undefined
    if (colScore === null || colScore === undefined) continue;
    if (rowScore === null || rowScore === undefined) continue;

    const colDigit = colScore % 10;
    const rowDigit = rowScore % 10;

    const colIndex = colNumbers.indexOf(colDigit);
    const rowIndex = rowNumbers.indexOf(rowDigit);

    if (colIndex === -1 || rowIndex === -1) continue;

    winners.push({
      periodIndex: i,
      label: periodLabels[i],
      position: rowIndex * 10 + colIndex,
      colDigit,
      rowDigit,
      colScore,
      rowScore,
    });
  }

  return winners;
}
EOF_SRC_LIB_WINNERS_TS
echo "  ✓ src/lib/winners.ts"

# --- src/app/api/boards/[id]/scores/route.ts ---
mkdir -p "$(dirname 'src/app/api/boards/[id]/scores/route.ts')"
cat > 'src/app/api/boards/[id]/scores/route.ts' << 'EOF_SRC_APP_API_BOARDS_ID_SCORES_ROUTE_TS'
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
}

type ScoresBody = {
  scoresTeamA: number[]; // col team scores per period
  scoresTeamB: number[]; // row team scores per period
};

export async function POST(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    // 1. Auth
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    // 2. Board + ownership
    const board = await prisma.board.findUnique({
      where: { boardId: id },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Must be closed (numbers assigned)
    if (board.status !== "closed") {
      return NextResponse.json(
        { error: "Board must be closed with numbers assigned before entering scores." },
        { status: 409 }
      );
    }

    // 3b. Belt-and-suspenders: numbers must actually exist
    if (
      !board.rowNumbers ||
      !board.colNumbers ||
      board.rowNumbers.length !== 10 ||
      board.colNumbers.length !== 10
    ) {
      return NextResponse.json(
        { error: "Board numbers have not been assigned yet." },
        { status: 409 }
      );
    }

    // 4. Parse + validate — arrays must match periodLabels length
    const body: ScoresBody = await request.json();

    if (!Array.isArray(body.scoresTeamA) || !Array.isArray(body.scoresTeamB)) {
      return NextResponse.json(
        { error: "scoresTeamA and scoresTeamB must be arrays." },
        { status: 400 }
      );
    }

    const n = board.periodLabels.length;

    if (body.scoresTeamA.length !== n || body.scoresTeamB.length !== n) {
      return NextResponse.json(
        { error: `Scores arrays must match periodLabels length (${n}).` },
        { status: 400 }
      );
    }

    for (let i = 0; i < n; i++) {
      const a = body.scoresTeamA[i];
      const b = body.scoresTeamB[i];

      if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b < 0) {
        return NextResponse.json(
          { error: `Invalid score at index ${i}. Scores must be non-negative integers.` },
          { status: 400 }
        );
      }
    }

    // 5. Save
    const updated = await prisma.board.update({
      where: { boardId: id },
      data: {
        scoresTeamA: body.scoresTeamA,
        scoresTeamB: body.scoresTeamB,
      },
      select: { scoresTeamA: true, scoresTeamB: true, periodLabels: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Score update error:", error);
    return NextResponse.json(
      { error: "Failed to update scores." },
      { status: 500 }
    );
  }
}
EOF_SRC_APP_API_BOARDS_ID_SCORES_ROUTE_TS
echo "  ✓ src/app/api/boards/[id]/scores/route.ts"

# --- src/app/api/boards/[id]/close/route.ts ---
mkdir -p "$(dirname 'src/app/api/boards/[id]/close/route.ts')"
cat > 'src/app/api/boards/[id]/close/route.ts' << 'EOF_SRC_APP_API_BOARDS_ID_CLOSE_ROUTE_TS'
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Fisher-Yates shuffle — produces an unbiased permutation of [0-9].
 */
function shuffleArray(): number[] {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function POST(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    // 2. Fetch board + ownership check
    const board = await prisma.board.findUnique({
      where: { boardId: id },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Guard: only open boards can be closed
    if (board.status !== "open") {
      return NextResponse.json(
        { error: `Board is already ${board.status}. Cannot close.` },
        { status: 409 }
      );
    }

    // 4. Atomic transition: open → closed with numbers assigned
    //    Single write with optimistic lock on status = "open".
    //    Race condition: two concurrent close requests → only one succeeds.
    const rowNumbers = shuffleArray();
    const colNumbers = shuffleArray();

    const { count } = await prisma.board.updateMany({
      where: { boardId: id, status: "open" },
      data: {
        status: "closed",
        rowNumbers,
        colNumbers,
      },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "Board was already closed by another request." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      status: "closed",
      rowNumbers,
      colNumbers,
    });
  } catch (error) {
    console.error("Close board error:", error);
    return NextResponse.json(
      { error: "Failed to close board." },
      { status: 500 }
    );
  }
}
EOF_SRC_APP_API_BOARDS_ID_CLOSE_ROUTE_TS
echo "  ✓ src/app/api/boards/[id]/close/route.ts"

# --- src/app/api/boards/route.ts ---
mkdir -p "$(dirname 'src/app/api/boards/route.ts')"
cat > 'src/app/api/boards/route.ts' << 'EOF_SRC_APP_API_BOARDS_ROUTE_TS'
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { generateSlug } from "@/lib/slug";

// Period labels derived from periodType
const PERIOD_LABELS: Record<string, string[]> = {
  halves: ["H1", "Final"],
  quarters: ["Q1", "Q2", "Q3", "Q4"],
};

interface CreateBoardBody {
  gameName: string;
  squarePrice: number; // dollars (converted to cents)
  teamRow: string;
  teamCol: string;
  periodType?: "halves" | "quarters"; // defaults to halves for pilot
  payoutStructure: Record<string, number>; // keyed by period label, e.g. { "H1": 50, "Final": 50 }
}

export async function POST(request: Request) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    // 2. Stripe readiness gate
    if (!host.stripeChargesEnabled) {
      return NextResponse.json(
        { error: "Stripe account not ready. Complete onboarding first." },
        { status: 403 }
      );
    }

    // 3. Parse + validate body
    const body: CreateBoardBody = await request.json();

    if (!body.gameName?.trim()) {
      return NextResponse.json(
        { error: "Game name is required." },
        { status: 400 }
      );
    }

    if (!body.teamRow?.trim() || !body.teamCol?.trim()) {
      return NextResponse.json(
        { error: "Both team names are required." },
        { status: 400 }
      );
    }

    if (!body.squarePrice || body.squarePrice < 1) {
      return NextResponse.json(
        { error: "Price per square must be at least $1." },
        { status: 400 }
      );
    }

    // 4. Determine period type and labels
    const periodType = body.periodType ?? "halves"; // default for March Madness pilot
    const periodLabels = PERIOD_LABELS[periodType];

    if (!periodLabels) {
      return NextResponse.json(
        { error: "Invalid period type. Must be 'halves' or 'quarters'." },
        { status: 400 }
      );
    }

    // 5. Validate payout structure — keys must match periodLabels, values sum to 100%
    const payoutStructure = body.payoutStructure;

    if (!payoutStructure || typeof payoutStructure !== "object") {
      return NextResponse.json(
        { error: "Payout structure is required." },
        { status: 400 }
      );
    }

    // Check that every period label has a payout entry
    for (const label of periodLabels) {
      if (payoutStructure[label] == null) {
        return NextResponse.json(
          { error: `Payout structure must include "${label}".` },
          { status: 400 }
        );
      }
    }

    const values = periodLabels.map((l) => payoutStructure[l]);

    if (values.some((v) => typeof v !== "number" || v < 0)) {
      return NextResponse.json(
        { error: "Payout percentages cannot be negative." },
        { status: 400 }
      );
    }

    const total = values.reduce((sum, v) => sum + v, 0);
    if (Math.abs(total - 100) > 0.01) {
      return NextResponse.json(
        { error: "Payout percentages must total 100%." },
        { status: 400 }
      );
    }

    // 6. Generate unique slug (retry on collision)
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 7. Create Board + 100 Squares in one transaction
    const squarePriceCents = Math.round(body.squarePrice * 100);

    const board = await prisma.$transaction(async (tx) => {
      const newBoard = await tx.board.create({
        data: {
          hostId: host.id,
          gameName: body.gameName.trim(),
          squarePrice: squarePriceCents,
          totalSquares: 100,
          status: "open",
          slug,
          teamRow: body.teamRow.trim(),
          teamCol: body.teamCol.trim(),
          periodType,
          periodLabels,
          payoutStructure,
          maxSquaresPerPlayer: 10,
          currency: "USD",
          hostPayoutResponsible: true,
        },
      });

      // Create 100 squares (positions 0-99)
      await tx.square.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          boardId: newBoard.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });

      return newBoard;
    });

    return NextResponse.json({
      boardId: board.boardId,
      slug: board.slug,
    });
  } catch (error) {
    console.error("Board creation error:", error);
    return NextResponse.json(
      { error: "Failed to create board." },
      { status: 500 }
    );
  }
}
EOF_SRC_APP_API_BOARDS_ROUTE_TS
echo "  ✓ src/app/api/boards/route.ts"

# --- src/app/host/boards/[id]/page.tsx ---
mkdir -p "$(dirname 'src/app/host/boards/[id]/page.tsx')"
cat > 'src/app/host/boards/[id]/page.tsx' << 'EOF_SRC_APP_HOST_BOARDS_ID_PAGE_TSX'
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import CopyLinkButton from "./copy-link";
import BoardGrid from "./grid";
import CloseBoardButton from "./close-button";
import ScoreEntry from "./score-entry";
import { calculateWinnersFromArrays } from "@/lib/winners";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function HostBoardPage({ params }: Props) {
  const { id } = await params;
  const host = await getHost();
  if (!host) redirect("/login");

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    include: {
      squares: {
        orderBy: { position: "asc" },
      },
    },
  });

  if (!board || board.hostId !== host.id) {
    notFound();
  }

  const paidCount = board.squares.filter(
    (s) => s.paymentStatus === "paid"
  ).length;
  const pendingCount = board.squares.filter(
    (s) => s.paymentStatus === "pending"
  ).length;
  const boardUrl = `${process.env.NEXT_PUBLIC_URL}/board/${board.slug}`;
  const isOpen = board.status === "open";
  const hasNumbers = board.rowNumbers && board.colNumbers;

  // Payout structure keyed by period labels: { "H1": 50, "Final": 50 }
  const payout = board.payoutStructure as Record<string, number> | null;
  const totalPot = (board.squarePrice / 100) * board.totalSquares;

  // Calculate winners from typed arrays
  const winners = calculateWinnersFromArrays(
    board.periodLabels,
    board.scoresTeamA,
    board.scoresTeamB,
    board.rowNumbers,
    board.colNumbers
  );
  const winnerPositions = new Set(winners.map((w) => w.position));

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{board.gameName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            ${board.squarePrice / 100} per square · ${totalPot} total pot
          </p>
          {(board.teamCol || board.teamRow) && (
            <p className="text-xs text-gray-600 mt-0.5">
              {board.teamCol} vs {board.teamRow}
            </p>
          )}
        </div>
        <span
          className={`text-xs px-2.5 py-1 rounded-full font-medium ${
            isOpen
              ? "bg-green-950 text-green-400 border border-green-900"
              : "bg-gray-800 text-gray-400 border border-gray-700"
          }`}
        >
          {board.status}
        </span>
      </div>

      {/* Copy Link — always accessible */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
        <p className="text-xs text-gray-500 mb-2">Share this link with your group</p>
        <CopyLinkButton url={boardUrl} />
      </div>

      {/* Fill Tracker */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-500"
            style={{ width: `${(paidCount / board.totalSquares) * 100}%` }}
          />
        </div>
        <span className="text-sm font-medium tabular-nums">
          {paidCount}
          <span className="text-gray-500"> / {board.totalSquares}</span>
        </span>
      </div>

      {/* Pending indicator */}
      {pendingCount > 0 && (
        <p className="text-xs text-yellow-400/70 mb-4">
          {pendingCount} square{pendingCount > 1 ? "s" : ""} pending payment
        </p>
      )}

      {/* Close Board button — only when open */}
      {isOpen && (
        <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
          <div>
            <p className="text-sm font-medium">Ready to close?</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Numbers will randomize immediately. No changes after this.
            </p>
          </div>
          <CloseBoardButton boardId={board.boardId} />
        </div>
      )}

      {/* Randomized confirmation */}
      {hasNumbers && (
        <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 mb-6">
          <p className="text-sm text-green-300 font-medium">
            Numbers are set. Board is live for game day.
          </p>
        </div>
      )}

      {/* Score entry — only when board is closed with numbers */}
      {hasNumbers && board.teamCol && board.teamRow && (
        <div className="mb-6">
          <ScoreEntry
            boardId={board.boardId}
            teamCol={board.teamCol}
            teamRow={board.teamRow}
            periodLabels={board.periodLabels}
            existingScoresA={board.scoresTeamA}
            existingScoresB={board.scoresTeamB}
          />
        </div>
      )}

      {/* Winner summary cards — dynamic from periodLabels */}
      {winners.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-6">
          {winners.map((w) => {
            const sq = board.squares[w.position];
            const periodPct = payout?.[w.label] ?? 0;
            const prize = Math.round(totalPot * (periodPct / 100));

            return (
              <div
                key={w.label}
                className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-3"
              >
                <div className="text-[10px] text-yellow-500 uppercase tracking-wider font-medium">
                  {w.label} Winner
                </div>
                <div className="text-sm font-bold text-yellow-300 mt-0.5">
                  {sq?.playerName ?? "—"}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {board.teamCol} {w.colScore} – {board.teamRow} {w.rowScore}
                  <span className="text-yellow-500/70 ml-1">→ ${prize}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Payout structure — dynamic from periodLabels */}
      {payout && (
        <div className="flex gap-3 mb-6">
          {board.periodLabels.map((label) => {
            const pct = payout[label] ?? 0;
            return (
              <div
                key={label}
                className="flex-1 rounded-lg border border-gray-800 bg-gray-900 p-2.5 text-center"
              >
                <div className="text-xs text-gray-500">{label}</div>
                <div className="text-sm font-medium mt-0.5">
                  {pct}%
                  <span className="text-xs text-gray-600 ml-1">
                    ${Math.round(totalPot * (pct / 100))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Grid — with numbers, team names, and winner highlighting */}
      <BoardGrid
        squares={board.squares}
        rowNumbers={board.rowNumbers ?? undefined}
        colNumbers={board.colNumbers ?? undefined}
        teamCol={board.teamCol ?? undefined}
        teamRow={board.teamRow ?? undefined}
        winnerPositions={winnerPositions}
      />
    </div>
  );
}
EOF_SRC_APP_HOST_BOARDS_ID_PAGE_TSX
echo "  ✓ src/app/host/boards/[id]/page.tsx"

# --- src/app/host/boards/[id]/score-entry.tsx ---
mkdir -p "$(dirname 'src/app/host/boards/[id]/score-entry.tsx')"
cat > 'src/app/host/boards/[id]/score-entry.tsx' << 'EOF_SRC_APP_HOST_BOARDS_ID_SCORE_ENTRY_TSX'
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ScoreEntryProps {
  boardId: string;
  teamCol: string;
  teamRow: string;
  periodLabels: string[];
  existingScoresA: number[] | null;
  existingScoresB: number[] | null;
}

export default function ScoreEntry({
  boardId,
  teamCol,
  teamRow,
  periodLabels,
  existingScoresA,
  existingScoresB,
}: ScoreEntryProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Track input values as strings so empty fields work cleanly
  const [inputsA, setInputsA] = useState<string[]>(() =>
    periodLabels.map((_, i) =>
      existingScoresA?.[i] !== undefined && existingScoresA?.[i] !== null
        ? String(existingScoresA[i])
        : ""
    )
  );
  const [inputsB, setInputsB] = useState<string[]>(() =>
    periodLabels.map((_, i) =>
      existingScoresB?.[i] !== undefined && existingScoresB?.[i] !== null
        ? String(existingScoresB[i])
        : ""
    )
  );

  function updateInput(
    team: "a" | "b",
    index: number,
    value: string
  ) {
    if (team === "a") {
      setInputsA((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    } else {
      setInputsB((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    }
    setSaved(false);
  }

  // Check if at least one complete period has scores
  function hasAnyScores(): boolean {
    return periodLabels.some(
      (_, i) => inputsA[i] !== "" && inputsB[i] !== ""
    );
  }

  async function saveScores() {
    // Build arrays — fill incomplete periods with existing values or 0
    const scoresA = periodLabels.map((_, i) => {
      const val = parseInt(inputsA[i], 10);
      return isNaN(val) ? (existingScoresA?.[i] ?? 0) : val;
    });
    const scoresB = periodLabels.map((_, i) => {
      const val = parseInt(inputsB[i], 10);
      return isNaN(val) ? (existingScoresB?.[i] ?? 0) : val;
    });

    // Validate all values are non-negative
    if (scoresA.some((v) => v < 0) || scoresB.some((v) => v < 0)) {
      setError("Scores must be non-negative.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await fetch(`/api/boards/${boardId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scoresTeamA: scoresA,
          scoresTeamB: scoresB,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save scores.");
        setSaving(false);
        return;
      }

      setSaving(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm font-medium mb-3">Enter Scores</p>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_80px_80px] gap-2 mb-2 text-[10px] text-gray-500 uppercase tracking-wider">
        <div />
        <div className="text-center">{teamCol}</div>
        <div className="text-center">{teamRow}</div>
      </div>

      {/* Period rows — dynamic from periodLabels */}
      {periodLabels.map((label, i) => (
        <div
          key={label}
          className="grid grid-cols-[1fr_80px_80px] gap-2 items-center mb-2"
        >
          <div className="text-xs text-gray-400 font-medium">{label}</div>
          <input
            type="number"
            min="0"
            value={inputsA[i] ?? ""}
            onChange={(e) => updateInput("a", i, e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
            placeholder="—"
          />
          <input
            type="number"
            min="0"
            value={inputsB[i] ?? ""}
            onChange={(e) => updateInput("b", i, e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
            placeholder="—"
          />
        </div>
      ))}

      {/* Save button */}
      <button
        onClick={saveScores}
        disabled={saving || !hasAnyScores()}
        className={`mt-2 w-full rounded px-3 py-2 text-sm font-medium transition-colors ${
          saved
            ? "bg-green-950 text-green-400 border border-green-900"
            : "bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700"
        } disabled:opacity-50`}
      >
        {saving ? "Saving…" : saved ? "✓ Scores Saved" : "Save Scores"}
      </button>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
EOF_SRC_APP_HOST_BOARDS_ID_SCORE_ENTRY_TSX
echo "  ✓ src/app/host/boards/[id]/score-entry.tsx"

# --- src/app/host/boards/[id]/close-button.tsx ---
mkdir -p "$(dirname 'src/app/host/boards/[id]/close-button.tsx')"
cat > 'src/app/host/boards/[id]/close-button.tsx' << 'EOF_SRC_APP_HOST_BOARDS_ID_CLOSE_BUTTON_TSX'
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CloseBoardButton({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function handleClose() {
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`/api/boards/${boardId}/close`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to close board");
        setLoading(false);
        setConfirming(false);
        return;
      }

      // Refresh the page to show closed state with numbers
      router.refresh();
    } catch {
      alert("Failed to close board");
      setLoading(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {confirming && !loading && (
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          Cancel
        </button>
      )}
      <button
        onClick={handleClose}
        disabled={loading}
        className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          confirming
            ? "bg-red-600 text-white hover:bg-red-500"
            : "bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700"
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {loading
          ? "Closing…"
          : confirming
            ? "Confirm — close & randomize"
            : "Close Board"}
      </button>
    </div>
  );
}
EOF_SRC_APP_HOST_BOARDS_ID_CLOSE_BUTTON_TSX
echo "  ✓ src/app/host/boards/[id]/close-button.tsx"

# --- src/app/host/boards/page.tsx ---
mkdir -p "$(dirname 'src/app/host/boards/page.tsx')"
cat > 'src/app/host/boards/page.tsx' << 'EOF_SRC_APP_HOST_BOARDS_PAGE_TSX'
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function HostBoardsPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  const stripeConnected = host.stripeChargesEnabled;

  const boards = await prisma.board.findMany({
    where: { hostId: host.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          squares: { where: { paymentStatus: "paid" } },
        },
      },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold">Your Boards</h1>
        {stripeConnected ? (
          <Link
            href="/host/boards/new"
            className="rounded-lg bg-white text-gray-950 px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            New Board
          </Link>
        ) : (
          <Link
            href="/host/stripe"
            className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-500 transition-colors"
          >
            Connect Stripe to start
          </Link>
        )}
      </div>

      {/* Stripe not ready banner */}
      {!stripeConnected && (
        <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-4 mb-6">
          <p className="text-sm text-yellow-200 font-medium mb-1">
            {host.stripeAccountId
              ? "Finish Stripe setup"
              : "Connect Stripe to get started"}
          </p>
          <p className="text-xs text-yellow-200/60">
            {host.stripeAccountId
              ? "Your Stripe account isn't fully verified yet. Complete onboarding so players can pay you."
              : "Connect your Stripe account so players can pay you directly. Board creation is locked until this is complete."}
          </p>
        </div>
      )}

      {/* Board list */}
      {boards.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">
            {stripeConnected
              ? "No boards yet. Create your first one."
              : "Connect Stripe, then create your first board."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {boards.map((board) => (
            <Link
              key={board.boardId}
              href={`/host/boards/${board.boardId}`}
              className="block rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-gray-700 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{board.gameName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {board._count.squares} / {board.totalSquares} paid
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    board.status === "open"
                      ? "bg-green-950 text-green-400 border border-green-900"
                      : "bg-gray-800 text-gray-400 border border-gray-700"
                  }`}
                >
                  {board.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
EOF_SRC_APP_HOST_BOARDS_PAGE_TSX
echo "  ✓ src/app/host/boards/page.tsx"

# --- src/app/host/boards/new/form.tsx ---
mkdir -p "$(dirname 'src/app/host/boards/new/form.tsx')"
cat > 'src/app/host/boards/new/form.tsx' << 'EOF_SRC_APP_HOST_BOARDS_NEW_FORM_TSX'
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Phase 1: default to halves for March Madness
// Future: surface a period type selector for CFB/NFL
const PERIOD_LABELS = ["H1", "Final"];
const DEFAULT_PAYOUTS: Record<string, number> = { H1: 50, Final: 50 };

export default function NewBoardForm() {
  const router = useRouter();
  const [gameName, setGameName] = useState("");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = Math.abs(payoutTotal - 100) <= 0.01;
  const priceNum = parseFloat(squarePrice);
  const formValid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0 &&
    priceNum >= 1 &&
    payoutValid;

  function updatePayout(label: string, value: string) {
    const num = parseFloat(value) || 0;
    setPayouts((prev) => ({ ...prev, [label]: num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formValid) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          squarePrice: priceNum,
          teamRow: teamRow.trim(),
          teamCol: teamCol.trim(),
          periodType: "halves",
          payoutStructure: payouts,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Failed to create board");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Game Name */}
      <div>
        <label htmlFor="gameName" className="block text-sm text-gray-400 mb-1.5">
          Game
        </label>
        <input
          id="gameName"
          type="text"
          required
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="e.g. March Madness R1 — Duke vs Vermont"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* Team Names */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="teamCol" className="block text-sm text-gray-400 mb-1.5">
            Team across top
          </label>
          <input
            id="teamCol"
            type="text"
            required
            value={teamCol}
            onChange={(e) => setTeamCol(e.target.value)}
            placeholder="e.g. Duke"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        <div>
          <label htmlFor="teamRow" className="block text-sm text-gray-400 mb-1.5">
            Team down side
          </label>
          <input
            id="teamRow"
            type="text"
            required
            value={teamRow}
            onChange={(e) => setTeamRow(e.target.value)}
            placeholder="e.g. Vermont"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* Price per Square */}
      <div>
        <label
          htmlFor="squarePrice"
          className="block text-sm text-gray-400 mb-1.5"
        >
          Price per square
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            $
          </span>
          <input
            id="squarePrice"
            type="number"
            required
            min="1"
            step="1"
            value={squarePrice}
            onChange={(e) => setSquarePrice(e.target.value)}
            placeholder="10"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 pl-7 pr-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        {priceNum >= 1 && (
          <p className="text-xs text-gray-600 mt-1.5">
            100 squares × ${priceNum} = ${priceNum * 100} total pot
          </p>
        )}
      </div>

      {/* Payout Structure — dynamic from period labels */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Payout split
        </label>
        <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${PERIOD_LABELS.length}, 1fr)` }}>
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">
                {label}
              </div>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={payouts[label] || ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-2 py-2 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">
                  %
                </span>
              </div>
            </div>
          ))}
        </div>
        <p
          className={`text-xs mt-1.5 ${
            payoutValid ? "text-gray-600" : "text-red-400"
          }`}
        >
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!formValid || loading}
        className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
EOF_SRC_APP_HOST_BOARDS_NEW_FORM_TSX
echo "  ✓ src/app/host/boards/new/form.tsx"

# --- src/app/board/[slug]/page.tsx ---
mkdir -p "$(dirname 'src/app/board/[slug]/page.tsx')"
cat > 'src/app/board/[slug]/page.tsx' << 'EOF_SRC_APP_BOARD_SLUG_PAGE_TSX'
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import PlayerBoard from "./player-board";
import { calculateWinnersFromArrays } from "@/lib/winners";
import type { Metadata } from "next";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;

  const board = await prisma.board.findUnique({
    where: { slug },
    select: { gameName: true, squarePrice: true },
  });

  if (!board) return { title: "Board Not Found" };

  return {
    title: `${board.gameName} — Squares`,
    description: `$${board.squarePrice / 100} per square. Pick your square and pay to lock it in.`,
  };
}

export default async function PublicBoardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;

  const board = await prisma.board.findUnique({
    where: { slug },
    include: {
      squares: {
        orderBy: { position: "asc" },
        select: {
          squareId: true,
          position: true,
          playerName: true,
          paymentStatus: true,
        },
      },
      host: {
        select: { name: true },
      },
    },
  });

  if (!board) notFound();

  const paidCount = board.squares.filter(
    (s) => s.paymentStatus === "paid"
  ).length;

  // Payout structure keyed by period labels: { "H1": 50, "Final": 50 }
  const payout = board.payoutStructure as Record<string, number> | null;
  const totalPot = (board.squarePrice / 100) * board.totalSquares;

  // Calculate winners from typed arrays
  const winners = calculateWinnersFromArrays(
    board.periodLabels,
    board.scoresTeamA,
    board.scoresTeamB,
    board.rowNumbers,
    board.colNumbers
  );
  const winnerPositions = winners.map((w) => w.position);

  const clientSquares = board.squares;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Success banner */}
        {sp.success === "true" && (
          <div className="rounded-lg border border-green-900 bg-green-950/60 p-4 mb-6">
            <p className="text-sm text-green-300 font-medium">
              Payment confirmed — your square is locked in!
            </p>
          </div>
        )}

        {/* Cancelled banner */}
        {sp.cancelled === "true" && (
          <div className="rounded-lg border border-yellow-900 bg-yellow-950/60 p-4 mb-6">
            <p className="text-sm text-yellow-300 font-medium">
              Payment not completed. The square will be released automatically
              in a few minutes.
            </p>
          </div>
        )}

        {/* Header */}
        <div className="mb-5">
          <h1 className="text-xl font-bold">{board.gameName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            ${board.squarePrice / 100} per square
            {board.host.name && (
              <span> · hosted by {board.host.name}</span>
            )}
          </p>
        </div>

        {/* Fill Tracker */}
        <div className="flex items-center gap-4 mb-2">
          <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-500"
              style={{
                width: `${(paidCount / board.totalSquares) * 100}%`,
              }}
            />
          </div>
          <span className="text-sm font-medium tabular-nums">
            {paidCount}
            <span className="text-gray-500"> / {board.totalSquares}</span>
          </span>
        </div>

        {/* Payout structure — dynamic from periodLabels, show as dollars for players */}
        {payout && (
          <div className="flex gap-2 mb-5">
            {board.periodLabels.map((label) => {
              const pct = payout[label] ?? 0;
              return (
                <div
                  key={label}
                  className="flex-1 rounded-lg border border-gray-800 bg-gray-900 p-2 text-center"
                >
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                    {label}
                  </div>
                  <div className="text-xs font-medium mt-0.5">
                    ${Math.round(totalPot * (pct / 100))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Winner summary cards — dynamic from periodLabels */}
        {winners.length > 0 && (
          <div className="grid grid-cols-2 gap-2 mb-5">
            {winners.map((w) => {
              const sq = clientSquares[w.position];
              const periodPct = payout?.[w.label] ?? 0;
              const prize = Math.round(totalPot * (periodPct / 100));

              return (
                <div
                  key={w.label}
                  className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-3"
                >
                  <div className="text-[10px] text-yellow-500 uppercase tracking-wider font-medium">
                    {w.label} Winner
                  </div>
                  <div className="text-sm font-bold text-yellow-300 mt-0.5">
                    {sq?.playerName ?? "—"}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {board.teamCol} {w.colScore} – {board.teamRow} {w.rowScore}
                    <span className="text-yellow-500/70 ml-1">→ ${prize}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Board — interactive for open, read-only for closed */}
        <PlayerBoard
          boardId={board.boardId}
          slug={board.slug}
          squares={clientSquares}
          squarePrice={board.squarePrice}
          maxPerPlayer={board.maxSquaresPerPlayer}
          status={board.status}
          rowNumbers={board.rowNumbers ?? undefined}
          colNumbers={board.colNumbers ?? undefined}
          teamCol={board.teamCol ?? undefined}
          teamRow={board.teamRow ?? undefined}
          winnerPositions={winnerPositions}
        />
      </div>
    </div>
  );
}
EOF_SRC_APP_BOARD_SLUG_PAGE_TSX
echo "  ✓ src/app/board/[slug]/page.tsx"

echo ""
echo "Done! All 11 files written."
echo ""
echo "Now run:"
echo "  git add -A"
echo "  git diff --cached --stat"
echo "  git commit -m \"feat: period-based scoring (halves/quarters) — pilot defaults to halves\""
echo "  git push origin main"
