const fs = require('fs');
const file = 'src/app/host/boards/page.tsx';
let f = fs.readFileSync(file, 'utf8');

const hadCRLF = f.includes('\r\n');
if (hadCRLF) f = f.replace(/\r\n/g, '\n');

// Use regex to match the two Stripe redirect blocks with any whitespace between
const re = /( +if \(!host\.stripeAccountId\) \{\n\s+redirect\("\/host\/stripe"\);\n\s+\})\n+(\s+if \(host\.stripeAccountId && !host\.stripeChargesEnabled\) \{\n\s+redirect\("\/host\/stripe\?refresh=true"\);\n\s+\})/;

const match = f.match(re);
if (!match) {
  console.error('ERROR: Could not find Stripe redirect blocks');
  process.exit(1);
}

const replacement = `  // Only require Stripe for hosts who chose card payments
  if (host.paymentPreference === "stripe") {
    if (!host.stripeAccountId) {
      redirect("/host/stripe");
    }
    if (host.stripeAccountId && !host.stripeChargesEnabled) {
      redirect("/host/stripe?refresh=true");
    }
  }`;

f = f.replace(re, replacement);

if (hadCRLF) f = f.replace(/\n/g, '\r\n');

fs.writeFileSync(file, f);
console.log('SUCCESS: Cash hosts now skip Stripe redirect');
