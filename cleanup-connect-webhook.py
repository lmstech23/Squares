"""
Run from your project root:
  python cleanup-connect-webhook.py
"""
import re

FILE = "src/app/api/webhooks/stripe/route.ts"

with open(FILE, "r", encoding="utf-8") as f:
    c = f.read()

# 1. Simplify checkout.session.completed case
old = """      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.metadata?.type === "credit_purchase") {
          await handleCreditPurchase(session);
        } else {
          await handleCheckoutCompleted(session);
        }
        break;
      }"""

new = """      case "checkout.session.completed": {
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        break;
      }"""

if old in c:
    c = c.replace(old, new)
    print("✓ Simplified checkout.session.completed case")
else:
    print("⚠ Could not find checkout case to replace — check manually")

# 2. Remove handleCreditPurchase function
pattern = r'/\*\*\s*\n\s*\* NEW: Credit purchase completed.*?^}'
match = re.search(pattern, c, flags=re.DOTALL | re.MULTILINE)
if match:
    c = c[:match.start()] + c[match.end():]
    print("✓ Removed handleCreditPurchase function")
else:
    print("⚠ Could not find handleCreditPurchase function — check manually")

with open(FILE, "w", encoding="utf-8") as f:
    f.write(c)

print("\nDone! Now run:")
print('  grep -n "credit_purchase\\|handleCreditPurchase" src/app/api/webhooks/stripe/route.ts')
print("  (should return nothing)")
