// ============================================================
// src/lib/constants.ts
// Single source of truth. When the tournament ends, update here.
// ============================================================

// --- Host cap ---
export const MAX_HOSTS = 10;

// --- Board credits ---
export const SIGNUP_CREDITS = 2;

// --- Pricing ---
export const CREDIT_PRICE_CENTS = 900;   // $9 during tournament → 1900 after
export const CREDIT_PRICE_DISPLAY = "$9"; // "$9" during tournament → "$19" after

// --- Invite codes ---
export const TOURNAMENT_END = new Date("2026-04-08T00:00:00Z"); // day after championship
