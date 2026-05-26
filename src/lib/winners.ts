export interface Winner {
  periodIndex: number;
  label: string; // e.g. "H1" or "Q2" or "Final"
  position: number; // 0-99
  colDigit: number;
  rowDigit: number;
  colScore: number;
  rowScore: number;
}

/**
 * Calculates winners for each period using:
 * last digit of TeamA score (columns) and TeamB score (rows),
 * and the board's shuffled 0–9 number assignments.
 *
 * teamA = col team (top)
 * teamB = row team (side)
 *
 * Stores FULL scores — computes last digit in code via % 10.
 */
export function calculateWinnersFromArrays(
  periodLabels: string[] | null,
  scoresTeamA: number[] | null,
  scoresTeamB: number[] | null,
  rowNumbers: number[] | null,
  colNumbers: number[] | null
): Winner[] {
  if (!periodLabels || !rowNumbers || !colNumbers) return [];
  if (rowNumbers.length !== 10 || colNumbers.length !== 10) return [];
  if (!scoresTeamA || !scoresTeamB) return [];

  const n = periodLabels.length;
  if (scoresTeamA.length !== n || scoresTeamB.length !== n) return [];

  const winners: Winner[] = [];

  for (let i = 0; i < n; i++) {
    const colScore = scoresTeamA[i];
    const rowScore = scoresTeamB[i];

    // Allow "not entered yet" by skipping nullish/undefined
    if (colScore === null || colScore === undefined || colScore < 0) continue;
    if (rowScore === null || rowScore === undefined || rowScore < 0) continue;
    
    const colDigit = colScore % 10;
    const rowDigit = rowScore % 10;

    const colIndex = colNumbers.indexOf(colDigit);
    const rowIndex = rowNumbers.indexOf(rowDigit);

    if (colIndex === -1 || rowIndex === -1) continue;

    winners.push({
      periodIndex: i,
      label: periodLabels[i],
      position: rowIndex * 10 + colIndex,
      colDigit,
      rowDigit,
      colScore,
      rowScore,
    });
  }

  return winners;
}

/**
 * For Double grid boards (5×5):
 * Each row/col is a PAIR of digits (e.g. [3, 8]).
 * Winner = the row whose pair contains the rowDigit AND the col whose pair contains the colDigit.
 *
 * Position formula: rowIndex * 5 + colIndex, range 0-24.
 */
export function calculateWinnersFromPairs(
  periodLabels: string[] | null,
  scoresTeamA: number[] | null,
  scoresTeamB: number[] | null,
  rowPairs: number[][] | null,
  colPairs: number[][] | null
): Winner[] {
  if (!periodLabels || !rowPairs || !colPairs) return [];
  if (rowPairs.length !== 5 || colPairs.length !== 5) return [];
  if (!scoresTeamA || !scoresTeamB) return [];
  const n = periodLabels.length;
  if (scoresTeamA.length !== n || scoresTeamB.length !== n) return [];

  const winners: Winner[] = [];
  for (let i = 0; i < n; i++) {
    const colScore = scoresTeamA[i];
    const rowScore = scoresTeamB[i];
    if (colScore === null || colScore === undefined || colScore < 0) continue;
    if (rowScore === null || rowScore === undefined || rowScore < 0) continue;
    

    const colDigit = colScore % 10;
    const rowDigit = rowScore % 10;

    const colIndex = colPairs.findIndex((pair) => pair.includes(colDigit));
    const rowIndex = rowPairs.findIndex((pair) => pair.includes(rowDigit));
    if (colIndex === -1 || rowIndex === -1) continue;

    winners.push({
      periodIndex: i,
      label: periodLabels[i],
      position: rowIndex * 5 + colIndex,
      colDigit,
      rowDigit,
      colScore,
      rowScore,
    });
  }
  return winners;
}

/**
 * Dispatcher — picks the right winner calculation based on gridType.
 * Callers pass the board record directly; this routes to the correct strategy.
 */
export function calculateWinners(board: {
  gridType: "standard" | "double";
  periodLabels: string[] | null;
  scoresTeamA: number[] | null;
  scoresTeamB: number[] | null;
  rowNumbers: number[] | null;
  colNumbers: number[] | null;
  rowPairs: unknown;
  colPairs: unknown;
}): Winner[] {
  if (board.gridType === "double") {
    return calculateWinnersFromPairs(
      board.periodLabels,
      board.scoresTeamA,
      board.scoresTeamB,
      board.rowPairs as number[][] | null,
      board.colPairs as number[][] | null
    );
  }
  return calculateWinnersFromArrays(
    board.periodLabels,
    board.scoresTeamA,
    board.scoresTeamB,
    board.rowNumbers,
    board.colNumbers
  );
}