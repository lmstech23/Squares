#!/usr/bin/env python3
"""Fix #6 — Randomize team placement (row/col) on board close.
Run from your project root: python fix-team-randomize.py
"""

import sys

FILE = "src/app/api/boards/[id]/close/route.ts"

try:
    with open(FILE, "r") as f:
        content = f.read()
except FileNotFoundError:
    print(f"✗ Not found: {FILE}")
    sys.exit(1)

# 1. Add coin flip after colNumbers generation
old_1 = "const colNumbers = shuffleArray();"
new_1 = """const colNumbers = shuffleArray();

    // 50/50 coin flip: randomly swap which team is on which axis
    const swapTeams = Math.random() < 0.5;
    const finalTeamRow = swapTeams && board.teamRow && board.teamCol ? board.teamCol : board.teamRow;
    const finalTeamCol = swapTeams && board.teamRow && board.teamCol ? board.teamRow : board.teamCol;"""

if old_1 not in content:
    print("✗ Could not find colNumbers line to patch")
    sys.exit(1)

content = content.replace(old_1, new_1, 1)

# 2. Add team swap to the updateMany data block
old_2 = """data: {
        status: "closed",
        rowNumbers,
        colNumbers,
      },"""

new_2 = """data: {
        status: "closed",
        rowNumbers,
        colNumbers,
        teamRow: finalTeamRow,
        teamCol: finalTeamCol,
      },"""

if old_2 not in content:
    print("✗ Could not find updateMany data block to patch")
    sys.exit(1)

content = content.replace(old_2, new_2, 1)

with open(FILE, "w") as f:
    f.write(content)

print(f"✓ Fixed: {FILE}")
print()
print('Verify: grep -A8 "swapTeams" "src/app/api/boards/[id]/close/route.ts"')
