import sys

def replace_once(content, old, new, label):
    count = content.count(old)
    if count == 0:
        print(f"  ✗ FAILED — target string not found in {label}")
        sys.exit(1)
    if count > 1:
        print(f"  ✗ FAILED — target string not unique in {label}")
        sys.exit(1)
    return content.replace(old, new)

def patch(filepath, replacements):
    with open(filepath, "r", encoding="utf-8") as f:
        original = content = f.read()
    original_lines = original.count("\n")
    for old, new in replacements:
        content = replace_once(content, old, new, filepath)
    new_lines = content.count("\n")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ✓ {filepath}  ({original_lines} → {new_lines} lines)")

patch("src/components/host-payment-info.tsx", [
    (
        "  cashapp: string | null;\n  visibility",
        "  cashapp: string | null;\n  paypal: string | null;\n  visibility",
    ),
    (
        "  cashapp,\n  visibility",
        "  cashapp,\n  paypal,\n  visibility",
    ),
    (
        "  const hasAny = venmo || zelle || cashapp;",
        "  const hasAny = venmo || zelle || cashapp || paypal;",
    ),
    (
        "  if (cashapp) methods.push(\"CashApp: \" + cashapp);",
        "  if (cashapp) methods.push(\"CashApp: \" + cashapp);\n  if (paypal) methods.push(\"PayPal: \" + paypal);",
    ),
])

print("\nDone. Now run:")
print("  git add -A && git commit -m 'add PayPal to HostPaymentInfo' && git push")
