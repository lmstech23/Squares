f = open("prisma/schema.prisma", "r", encoding="utf-8").read()

# Remove from wrong spot (Board model)
f = f.replace('  paymentPreference  String?  @map("payment_preference")\n', '')

# Add to Host model before @@map("hosts")
f = f.replace(
    '  @@map("hosts")',
    '  paymentPreference         String?             @map("payment_preference")\n\n  @@map("hosts")'
)

open("prisma/schema.prisma", "w", encoding="utf-8").write(f)
print("fixed")
