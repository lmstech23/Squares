#!/usr/bin/env bash
#
# T7 — static guard for RULE E2.
#
# No file on the Event path may reference Board, Host, credit, or Stripe state.
# This is the rule most likely to be broken accidentally, months from now, by
# someone adding a feature in good faith. A grep in CI is what makes E2 survive
# that. Reviewer attention is not a control.
#
# Usage:  ./scripts/check-event-isolation.sh      (or: npm run check:event-isolation)
# Exit 1 on any violation. Wire into CI before merge.
#
# EXTENDED AT THE PORT (Daali Event Port Plan, P5; Risks table, Oct 7 correction).
# The Sep 10 script checked rule (a) below over the paths it knew about. The port
# adds the paths the package actually ships, and three more rules:
#
#   (a) E2 — Board, Host, Stripe, payment and credit identifiers (Sep 10 list,
#       plus getHostOrNull, the auth/stripe modules, and hosts-table access).
#   (b) the LEGACY accessors. The legacy schema keeps model Event, SignupSheet,
#       SignupSlot, HelperSignup, HelperSignupPosition, SignupLog and
#       NotificationDelivery, so a missed `prisma.event` still compiles and
#       reads the legacy table. The port's own delegates are prisma.daali*.
#   (c) a direct Prisma write outside the command layer and its named db
#       helpers. Test files (*.test.ts) are not checked by (c): an integration
#       test seeds and clears its own fixtures with $executeRaw by necessity.
#       Rules (a), (b) and (d) still apply to them.
#   (d) the Event path never lives under, or imports from, the host app: a file
#       under src/app/host that is not in the baseline below fails, and so does
#       any scanned file importing from app/host.
#
# Comments count as violations on purpose, as on Sep 10 — a commented-out
# getHost() call is a re-enable waiting to happen.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

PATHS=(
  # Sep 10 paths. Page directories that do not exist yet are skipped, and are
  # checked automatically once Slices 3-4 add them.
  "src/app/events"
  "src/app/e"
  "src/app/api/events"
  "src/app/api/registrations"
  "src/app/api/slots"
  "src/app/api/signups"
  "src/lib/currentOrganizer.ts"
  "src/commands/events"
  "src/domain"
  "src/db/eventPerson.ts"
  "src/db/capacity.ts"
  "src/db/signups.ts"
  "src/capabilities/eventCore.ts"
  # Added at the port: every path the package ships.
  "src/commands"
  "src/capabilities"
  "src/db"
  "src/notifications"
  "src/lib/commands"
  "src/lib/accessToken.ts"
  "src/lib/appUrl.ts"
  "src/lib/httpResult.ts"
  "src/app/api/notifications"
)

# (a) Forbidden identifiers. Word-boundary anchored to avoid matching e.g.
# "hostname" or "localhost".
FORBIDDEN=(
  '\bgetHost\b'
  '\bprisma\.host\b'
  '\bpayment_preference\b'
  '\bpaymentPreference\b'
  '\bboard_credits\b'
  '\bboardCredits\b'
  '\bstripe_account_id\b'
  '\bstripeAccountId\b'
  '\bstripe_charges_enabled\b'
  '\bstripeChargesEnabled\b'
  '\bstripe_payouts_enabled\b'
  '\bstripePayoutsEnabled\b'
  '\bCreditTransaction\b'
  '\bcashModeEnabled\b'
  '\bcashPin\b'
  # Added at the port.
  '\bgetHostOrNull\b'
  "from ['\"]@/lib/auth['\"]"
  "from ['\"]@/lib/stripe['\"]"
  "from ['\"]stripe['\"]"
  '\b(tx|db)\.host\b'
  '\bhosts\b'
  '\b(prisma|tx|db)\.creditTransaction\b'
  '\bcredit_transactions\b'
)

# (b) Legacy accessors, on the prisma client or a transaction client.
LEGACY_ACCESSOR='\b(prisma|tx)\.(event|signupSheet|signupSlot|helperSignup|helperSignupPosition|signupLog|notificationDelivery)\b'

# (c) A Prisma write: an operation called on a model delegate (client.model.op(),
# the shape every Prisma write takes), or a raw execute.
WRITE='\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw(Unsafe)?\b'

# Where a write is allowed. A directory ends in "/".
WRITE_ALLOWLIST=(
  "src/commands/"
  "src/lib/commands/runCommand.ts"
  "src/db/capacity.ts"
  "src/db/signups.ts"
  "src/db/eventPerson.ts"
  "src/lib/accessToken.ts"
  "src/notifications/enqueue.ts"
  "src/notifications/deliver.ts"
)

# (d) The host app as it stands on origin/main at the port (ab6de64). A file
# under src/app/host that is not listed here fails. A deliberate legacy change
# that adds one updates this list in the same commit, where review sees it.
HOST_BASELINE=(
  "src/app/host/boards/[id]/cash-mode-toggle.tsx"
  "src/app/host/boards/[id]/cash-reserve-panel.tsx"
  "src/app/host/boards/[id]/close-button.tsx"
  "src/app/host/boards/[id]/contributor-list.tsx"
  "src/app/host/boards/[id]/copy-link.tsx"
  "src/app/host/boards/[id]/donations/cash-donation-form.tsx"
  "src/app/host/boards/[id]/donations/confirm-button.tsx"
  "src/app/host/boards/[id]/donations/ledger-method.tsx"
  "src/app/host/boards/[id]/donations/page.tsx"
  "src/app/host/boards/[id]/donations/reservation-worklist.tsx"
  "src/app/host/boards/[id]/edit-details-button.tsx"
  "src/app/host/boards/[id]/edit-fundraiser-button.tsx"
  "src/app/host/boards/[id]/event-panel.tsx"
  "src/app/host/boards/[id]/fundraiser-panel.tsx"
  "src/app/host/boards/[id]/grid.tsx"
  "src/app/host/boards/[id]/managers-panel.tsx"
  "src/app/host/boards/[id]/notify-winner-button.tsx"
  "src/app/host/boards/[id]/page.tsx"
  "src/app/host/boards/[id]/score-entry.tsx"
  "src/app/host/boards/[id]/share-card.tsx"
  "src/app/host/boards/[id]/signup-panel.tsx"
  "src/app/host/boards/[id]/square-list.tsx"
  "src/app/host/boards/[id]/volunteers/loading.tsx"
  "src/app/host/boards/[id]/volunteers/page.tsx"
  "src/app/host/boards/[id]/winner-payout-card.tsx"
  "src/app/host/boards/components/dismiss-button.tsx"
  "src/app/host/boards/new/board-type-picker.tsx"
  "src/app/host/boards/new/form.tsx"
  "src/app/host/boards/new/fundraiser-form.tsx"
  "src/app/host/boards/new/grid-type-picker.tsx"
  "src/app/host/boards/new/new-board-flow.tsx"
  "src/app/host/boards/new/page.tsx"
  "src/app/host/boards/page.tsx"
  "src/app/host/layout.tsx"
  "src/app/host/nav.tsx"
  "src/app/host/page.tsx"
  "src/app/host/payment-setup/page.tsx"
  "src/app/host/stripe/page.tsx"
  "src/app/host/stripe/return/page.tsx"
)
HOST_IMPORT="from ['\"](@/app/host|(\.\./)+([A-Za-z0-9_\[\]-]+/)*app/host)(/|['\"])"

failed=0

report() {
  echo "VIOLATION [$1] — $2"
  echo "$3" | sed 's/^/    /'
  echo
  failed=1
}

# All existing scanned source files, once each.
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  for path in "${PATHS[@]}"; do
    [ -e "$path" ] || continue
    if [ -d "$path" ]; then find "$path" -type f \( -name '*.ts' -o -name '*.tsx' \); else echo "$path"; fi
  done | sort -u
)

# (a) E2
for pattern in "${FORBIDDEN[@]}"; do
  hits=$(grep -nE "$pattern" "${FILES[@]}" /dev/null 2>/dev/null)
  [ -n "$hits" ] && report "E2" "forbidden reference '$pattern'" "$hits"
done

# (b) legacy accessors
hits=$(grep -nE "$LEGACY_ACCESSOR" "${FILES[@]}" /dev/null 2>/dev/null)
[ -n "$hits" ] && report "LEGACY-ACCESSOR" "a legacy model delegate reached from the Event path (use prisma.daali*)" "$hits"

# (c) writes outside the allowlist
allowed() {
  local f="$1" a
  for a in "${WRITE_ALLOWLIST[@]}"; do
    case "$a" in
      */) [[ "$f" == "$a"* ]] && return 0 ;;
      *)  [[ "$f" == "$a" ]] && return 0 ;;
    esac
  done
  return 1
}
for f in "${FILES[@]}"; do
  case "$f" in *.test.ts) continue ;; esac
  allowed "$f" && continue
  hits=$(grep -nE "$WRITE" "$f" 2>/dev/null)
  [ -n "$hits" ] && report "WRITE" "a Prisma write outside src/commands/** and the named db helpers, in $f" "$hits"
done

# (d) host app: no new file under src/app/host, no import from it
if [ -d "src/app/host" ]; then
  while IFS= read -r f; do
    known=0
    for b in "${HOST_BASELINE[@]}"; do [[ "$f" == "$b" ]] && { known=1; break; }; done
    [ "$known" -eq 0 ] && report "HOST" "a file under src/app/host that is not in the baseline" "$f"
  done < <(find src/app/host -type f | sort)
fi
hits=$(grep -nE "$HOST_IMPORT" "${FILES[@]}" /dev/null 2>/dev/null)
[ -n "$hits" ] && report "HOST" "an Event-path file imports from the host app" "$hits"

# Second check: the Event path must not sit under a layout or middleware that
# guards on payment state. Grep cannot prove this — it flags the files a human
# must read.
if [ -f "middleware.ts" ] || [ -f "src/middleware.ts" ]; then
  mw=$(ls middleware.ts src/middleware.ts 2>/dev/null | head -1)
  if grep -qE 'matcher' "$mw" 2>/dev/null; then
    echo "MANUAL CHECK [E3] — confirm no matcher in $mw covers:"
    echo "    /events  /events/:path*  /e/:path*  /api/events/:path*"
    echo "    /api/registrations/:path*  /api/slots/:path*  /api/signups/:path*"
    echo "  Matchers are broad by default. A pattern written for /host can"
    echo "  cover routes that never opted in, and the gate will not appear in"
    echo "  any Event file."
    echo
  fi
fi

if [ "$failed" -eq 1 ]; then
  echo "Event path isolation FAILED. See RULE E2 in docs/phase0/event-path-gate-independence.md"
  exit 1
fi

echo "Event path isolation OK — ${#FILES[@]} files: no Board, Host, credit or Stripe references; no legacy accessors; no writes outside the command layer; no host-app files or imports."
exit 0
