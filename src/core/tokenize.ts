export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  for (const segment of normalized.split(/\s+/)) {
    if (CJK_PATTERN.test(segment)) {
      // CJK characters: each character is a meaningful token
      for (const char of segment) {
        if (CJK_PATTERN.test(char)) {
          tokens.push(char);
        } else if (char.trim()) {
          // Inline latin/digit within CJK context — keep if > 1 char is handled below
          tokens.push(char);
        }
      }
    } else if (segment.length > 1) {
      tokens.push(segment);
    }
  }
  return tokens;
}

export function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

export function tokenOverlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.length;
}
