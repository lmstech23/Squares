// ============================================================
// src/lib/constants.ts
// Single source of truth. When the tournament ends, update here.
// ============================================================


// --- Board credits ---
export const SIGNUP_CREDITS = 2;

// --- Pricing ---
export const CREDIT_PRICE_CENTS = 900;   // $9 during tournament → 1900 after
export const CREDIT_PRICE_DISPLAY = "$9"; // "$9" during tournament → "$19" after


// --- Platform owner (skip credit gates) ---
export const PLATFORM_OWNER_ID = process.env.PLATFORM_OWNER_ID!;
