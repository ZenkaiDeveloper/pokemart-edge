/** Guard list — alert email/Discord/RSS copy must never contain these. */

export const BANNED_PHRASES: RegExp[] = [
  /\bsnipe\b/i,
  /\bsteal\b/i,
  /\bmoon\b/i,
  /\bpump\b/i,
  /\bguaranteed\b/i,
  /\bcan'?t lose\b/i,
  /\bbuy now before\b/i,
  /\bundervalued\b/i,
  /\brestock\b/i,
  /\bauction ending\b/i,
  /\blive listing\b/i,
];

export function findBannedPhrase(text: string): string | null {
  for (const re of BANNED_PHRASES) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function assertNoBanned(text: string): void {
  const hit = findBannedPhrase(text);
  if (hit) throw new Error(`banned_phrase:${hit}`);
}
