// File contents travel through the engine as "binary strings" (latin1: one char per byte),
// so any encoding round-trips byte-exactly when we write a version back to disk or the index.

/** Splits text into lines, each keeping its own terminator. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Comparison key that ignores CRLF vs LF, so autocrlf checkouts don't look like rewrites. */
export function lineKey(line: string): string {
  return line.endsWith('\r\n') ? line.slice(0, -2) + '\n' : line;
}

export function sameText(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

export function isBinary(text: string | null): boolean {
  return text !== null && text.slice(0, 8000).includes('\0');
}

export function dominantEol(text: string | null): '\r\n' | '\n' | null {
  if (!text) return null;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r\n' : '\n';
}

/** Rewrites every line ending to `eol` (no-op when eol is null). */
export function withEol(text: string, eol: '\r\n' | '\n' | null): string {
  if (!eol) return text;
  return text.replace(/\r?\n/g, eol);
}

/** Converts a binary string to readable text for the diff editor. */
export function toDisplay(text: string | null): string {
  return text === null ? '' : Buffer.from(text, 'latin1').toString('utf8');
}
