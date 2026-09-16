// ============================================================
// src/lib/constants.ts
// Single source of truth. When the tournament ends, update here.
// ============================================================


// BOARD CREDITS ARE GONE. Daali does not charge an organizer to create
// anything: Game Day, Fundraiser, Event and Volunteer are all free. The
// signup grant, the $9/$24 packs and the gate they fed were removed with the
// feature. `credit_transactions` is retained as a historical financial
// record and confers nothing.

// --- Platform owner ---
//
// Still used, and no longer for credits: it hides the Connect-Stripe banner
// on the board list for the platform account.
export const PLATFORM_OWNER_ID = process.env.PLATFORM_OWNER_ID!;
