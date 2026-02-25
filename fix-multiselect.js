const fs = require('fs');
const file = 'src/app/board/[slug]/player-board.tsx';
let f = fs.readFileSync(file, 'utf8');
let changes = 0;

// Fix 1: Remove setShowModal(true) from handleSquareTap
const oldTap = `      setError("");
      setCashSuccess(false);
      setShowModal(true);
    },
    [isOpen, maxPerPlayer]
  );`;

const newTap = `      setError("");
      setCashSuccess(false);
    },
    [isOpen, maxPerPlayer]
  );`;

if (f.includes(oldTap)) {
  f = f.replace(oldTap, newTap);
  changes++;
  console.log('OK: Removed setShowModal(true) from handleSquareTap');
} else {
  console.error('ERROR: Could not find setShowModal in handleSquareTap');
  process.exit(1);
}

// Fix 2: Add floating checkout bar before the modal
// Find the modal block and insert a floating bar before it
const modalMarker = `      {/* Claim Modal — slides up */}
      {showModal && selectedCount > 0 && isOpen && (`;

const floatingBar = `      {/* Floating checkout bar — appears when squares are selected */}
      {selectedCount > 0 && isOpen && !showModal && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-4 bg-gradient-to-t from-gray-950 via-gray-950/95 to-transparent">
          <div className="max-w-lg mx-auto flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {selectedCount === 1
                  ? \`Square #\${Array.from(selectedSquares.values())[0].position + 1}\`
                  : \`\${selectedCount} squares selected\`}
              </p>
              <p className="text-xs text-gray-500">
                {totalPrice} total
              </p>
            </div>
            <div className="flex items-center gap-2 ml-3">
              <button
                onClick={handleClose}
                className="rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors"
              >
                Clear
              </button>
              <button
                onClick={() => setShowModal(true)}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors"
              >
                Checkout
              </button>
            </div>
          </div>
        </div>
      )}

`;

if (f.includes(modalMarker)) {
  f = f.replace(modalMarker, floatingBar + '      ' + modalMarker.trimStart());
  changes++;
  console.log('OK: Added floating checkout bar before modal');
} else {
  console.error('ERROR: Could not find modal marker');
  process.exit(1);
}

fs.writeFileSync(file, f);
console.log(`\nDONE: ${changes} changes applied`);
