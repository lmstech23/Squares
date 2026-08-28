// Who may create a fundraiser board — fundraiser-board-v2.md §14.
//
// Closed by default. Set FUNDRAISER_HOSTS to a comma-separated list of host
// emails to open it.
//
// WHY THIS EXISTS. Admission is half-built. A contributor pays, the receipt
// says "1 Ticket", and today that ticket exists only as a row in Postgres:
// there is no passes screen (A9) and no email (Phase C sends nothing for a
// fundraiser). Someone who knows the state of the build can work around that.
// A host who found the button takes real money for something the contributor
// cannot show at a gate.
//
// REMOVAL CONDITION, not a judgment call: lift this when A9 has shipped AND a
// ticket email exists. Both, not either. Stated as a condition so it neither
// lingers for a year nor comes off early because a board looked ready.
//
// Deleting the gate is deleting this file and its two call sites.

/**
 * Defaults to closed. An unset or empty variable allows nobody, so a
 * misconfigured deployment fails safe rather than opening the door.
 */
export function canCreateFundraiser(email: string | null | undefined): boolean {
  if (!email) return false;

  const allowed = (process.env.FUNDRAISER_HOSTS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}
