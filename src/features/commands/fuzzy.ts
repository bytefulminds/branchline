/** Result of matching a query against a text: a score (higher is better) and matched positions. */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const isBoundary = (text: string, i: number) =>
  i === 0 ||
  /[\s/._:-]/.test(text[i - 1]!) ||
  (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

/**
 * Case-insensitive subsequence match: every query character must appear in order.
 * Consecutive characters, word starts and an early first match score higher.
 * Spaces in the query are ignored, so "new br" matches "New branch".
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    // Prefer the next occurrence at a word start, else the next occurrence at all.
    let at = -1;
    for (let i = lower.indexOf(ch, from); i !== -1; i = lower.indexOf(ch, i + 1)) {
      if (at === -1) at = i;
      if (i === previous + 1 || isBoundary(text, i)) {
        at = i;
        break;
      }
    }
    if (at === -1) return null;
    score += 1;
    if (at === previous + 1) score += 4;
    if (isBoundary(text, at)) score += 3;
    indices.push(at);
    previous = at;
    from = at + 1;
  }
  score -= indices[0]! * 0.1 + text.length * 0.01;
  return { score, indices };
}
