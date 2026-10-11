// Line-level longest-common-subsequence via Myers' O(ND) algorithm.

/** Pairs [indexInA, indexInB] of matching lines, increasing in both. */
export type Matches = Array<[number, number]>;

/**
 * Returns the matched lines between `a` and `b`. When the two sides differ by more than
 * `maxEdits` lines in the middle, that middle is treated as fully replaced (no matches).
 */
export function lcs(a: readonly string[], b: readonly string[], maxEdits = 3000): Matches {
  const head: Matches = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    head.push([start, start]);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: Matches = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    tail.push([endA, endB]);
  }
  const middle = myers(a, start, endA, b, start, endB, maxEdits);
  return head.concat(middle, tail.reverse());
}

function myers(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number, maxEdits: number): Matches {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) return [];

  // Compare small integers instead of strings.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const A = Int32Array.from({ length: n }, (_, i) => intern(a[a0 + i]));
  const B = Int32Array.from({ length: m }, (_, i) => intern(b[b0 + i]));

  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxEdits);

  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, n, m, a0, b0);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return [];
}

function backtrack(trace: Int32Array[], n: number, m: number, a0: number, b0: number): Matches {
  const out: Matches = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push([a0 + x, b0 + y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([a0 + x, b0 + y]);
  }
  return out.reverse();
}
