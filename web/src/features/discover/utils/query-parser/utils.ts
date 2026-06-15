// @ts-nocheck
// Replace splitAndTrimCSV, should remove splitAndTrimCSV later
export function splitAndTrimWithBracket(input: string): string[] {
  let parenCount = 0;
  let squareCount = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  const res: string[] = [];
  let cur = "";
  for (const c of input + ",") {
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      cur += c;
      continue;
    }

    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      cur += c;
      continue;
    }
    // Only count brackets when not in quotes
    if (!inSingleQuote && !inDoubleQuote) {
      if (c === "(") {
        parenCount++;
      } else if (c === ")") {
        parenCount--;
      } else if (c === "[") {
        squareCount++;
      } else if (c === "]") {
        squareCount--;
      }
    }

    if (
      c === "," &&
      parenCount === 0 &&
      squareCount === 0 &&
      !inSingleQuote &&
      !inDoubleQuote
    ) {
      const trimString = cur.trim();
      if (trimString) {
        res.push(trimString);
      }
      cur = "";
    } else {
      cur += c;
    }
  }
  return res;
}
