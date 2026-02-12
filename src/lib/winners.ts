export interface QuarterScore {
  col: number; // teamCol score
  row: number; // teamRow score
}

export interface Scores {
  q1?: QuarterScore;
  q2?: QuarterScore;
  q3?: QuarterScore;
  final?: QuarterScore;
}

export interface Winner {
  quarter: string;
  label: string;
  position: number; // 0-99
  colDigit: number;
  rowDigit: number;
  colScore: number;
  rowScore: number;
}

/**
 * Calculate winning square positions from scores and number assignments.
 *
 * For each quarter:
 * - Last digit of teamCol score → find which column index has that number
 * - Last digit of teamRow score → find which row index has that number
 * - Intersection = winner position (row * 10 + col)
 */
export function calculateWinners(
  scores: Scores | null,
  rowNumbers: number[] | null,
  colNumbers: number[] | null
): Winner[] {
  if (!scores || !rowNumbers || !colNumbers) return [];
  if (rowNumbers.length !== 10 || colNumbers.length !== 10) return [];

  const winners: Winner[] = [];
  const quarters: [keyof Scores, string][] = [
    ["q1", "Q1"],
    ["q2", "Q2"],
    ["q3", "Q3"],
    ["final", "Final"],
  ];

  for (const [key, label] of quarters) {
    const score = scores[key];
    if (!score) continue;

    const colDigit = score.col % 10;
    const rowDigit = score.row % 10;

    const colIndex = colNumbers.indexOf(colDigit);
    const rowIndex = rowNumbers.indexOf(rowDigit);

    if (colIndex === -1 || rowIndex === -1) continue;

    winners.push({
      quarter: key,
      label,
      position: rowIndex * 10 + colIndex,
      colDigit,
      rowDigit,
      colScore: score.col,
      rowScore: score.row,
    });
  }

  return winners;
}
