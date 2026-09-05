// What a human calls the thing they bought.
//
// ONE RESOLVER, EVERY SURFACE. Host and contributor must never see different
// nouns for the same purchase unit: a host texting parents "go buy your $25
// ticket" while her own board says "$25 per square" is the product
// contradicting itself in her hand.
//
// The point of centralising it is the component nobody has written yet. A
// forgotten screen six months from now cannot say "squares" on a fundraiser if
// the only way to name the unit is to ask this function.
//
// DISPLAY ONLY. Nothing here renames `Square`, a database column, an API field,
// a route, or any schema concept. The model is squares all the way down; this
// is the word above it.

/** The two words that matter, plus their capitalised forms for headings. */
export interface UnitWords {
  one: string;
  many: string;
  One: string;
  Many: string;
}

export interface BoardVocabularyInput {
  /** "game" | "fundraiser" — Board.boardType. */
  boardType: string;
  /** Board has an associated Event. Same predicate that drives the CTA. */
  hasEvent: boolean;
  /** prizePoolPercent > 0. Never board type — a Phase B prize fundraiser needs it. */
  hasPrize: boolean;
}

const SQUARE: UnitWords = { one: "square", many: "squares", One: "Square", Many: "Squares" };
const TICKET: UnitWords = { one: "ticket", many: "tickets", One: "Ticket", Many: "Tickets" };
const ENTRY: UnitWords = { one: "entry", many: "entries", One: "Entry", Many: "Entries" };
const CONTRIBUTION: UnitWords = {
  one: "contribution",
  many: "contributions",
  One: "Contribution",
  Many: "Contributions",
};

/**
 * The purchase unit, as a person would say it.
 *
 *   Game Day                        square       a position on a grid, and
 *                                                genuinely what it is
 *   fundraiser + event              ticket       admits them to something
 *   fundraiser + prize, no event    entry        an entry in a drawing
 *   fundraiser, neither             contribution they gave; there is no object
 *
 * PRECEDENCE IS EXPLICIT, matching the CTA: `hasEvent` wins over `hasPrize` on
 * a board that is both, because admission is something the buyer needs at a
 * gate and a drawing is a chance. Written as ordered branches rather than
 * boolean juggling so a Phase B board turning on prizePoolPercent cannot
 * silently reword an existing screen.
 */
export function purchaseUnit(board: BoardVocabularyInput): UnitWords {
  if (board.boardType !== "fundraiser") return SQUARE;
  if (board.hasEvent) return TICKET;
  if (board.hasPrize) return ENTRY;
  return CONTRIBUTION;
}

/**
 * Event admission is ALWAYS a "pass", never a "ticket".
 *
 * Exported as words rather than hard-coded at each call site for the same
 * reason as the unit: one place to change, and one place to read.
 *
 * This exists because "ticket" briefly meant two things at once. On an event
 * fundraiser the purchase unit is a ticket AND admission was also called a
 * ticket, which reads fine at 1:1 and falls apart the moment someone ticks
 * "I won't be attending" and holds 1 ticket and 0 tickets. A supporter buys
 * TICKETS; what gets them through the gate is an admission PASS.
 */
export const ADMISSION: UnitWords = { one: "pass", many: "passes", One: "Pass", Many: "Passes" };

/**
 * The first line of EVERY successful fundraiser submit state.
 *
 * Four screens reach it — ticket by card, ticket by direct payment, donation
 * by card, donation by direct payment — and they live in three different
 * components. A constant, because four hand-written copies of one sentence is
 * four places for it to drift, and the whole point is that it does not.
 *
 * IT APPEARS ON THE RESERVATION SCREENS TOO, where no money has arrived yet.
 * Deliberate: the reservation screen is the ONLY screen a direct payer ever
 * sees, so leaving the thank-you off it means that contributor is never
 * thanked at all. What has and has not happened is said on the line below.
 */
export const CONTRIBUTION_THANKS = "Thank you for your contribution.";

/** The next-step line wherever payment is still owed. */
export const AWAITING_HOST_CONFIRMATION =
  "Payment is recorded once the host confirms receipt.";
