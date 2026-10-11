import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { lcs } from '../engine/diff';
import { applyChange, commitOwners, discardOwner, FileState, initialState, liveText, ownersOf, UNATTRIBUTED, virtualVersion } from '../engine/model';

const A = 'A';
const B = 'B';

const lines = (...xs: string[]) => xs.map((x) => x + '\n').join('');
const only = (s: FileState, owners: string[], base: string | null, disk: string | null) =>
  virtualVersion(s, (o) => owners.includes(o), base, disk);
const owners = (s: FileState) => [...ownersOf(s)].sort();

test('lcs matches brute-force LCS length on random inputs', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 400; round++) {
    const a = Array.from({ length: rand(12) }, () => 'xyz'[rand(3)]);
    const b = Array.from({ length: rand(12) }, () => 'xyz'[rand(3)]);
    const m = lcs(a, b);
    for (const [i, j] of m) assert.equal(a[i], b[j]);
    for (let k = 1; k < m.length; k++) assert.ok(m[k][0] > m[k - 1][0] && m[k][1] > m[k - 1][1]);
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    assert.equal(m.length, dp[0][0], `${a.join('')} / ${b.join('')}`);
  }
});

test('one agent edit is fully owned by that agent', () => {
  const base = lines('a', 'b', 'c');
  const after = lines('a', 'B!', 'c');
  const s = initialState(base);
  applyChange(s, A, base, after);
  applyChange(s, UNATTRIBUTED, undefined, after);
  assert.deepEqual(owners(s), [A]);
  assert.equal(only(s, [A], base, after).text, after);
  assert.equal(only(s, [], base, after).text, base);
});

test('two agents in the same file: each sees only its own lines', () => {
  const base = lines('1', '2', '3', '4', '5', '6');
  const s = initialState(base);
  const v1 = lines('1', 'two', '3', '4', '5', '6');
  applyChange(s, A, base, v1);
  const v2 = lines('1', 'two', '3', '4', '5', 'six', 'seven');
  applyChange(s, B, v1, v2);
  applyChange(s, UNATTRIBUTED, undefined, v2);
  assert.deepEqual(owners(s), [A, B]);
  assert.equal(only(s, [A], base, v2).text, v1);
  assert.equal(only(s, [B], base, v2).text, lines('1', '2', '3', '4', '5', 'six', 'seven'));
  assert.equal(only(s, [A, B], base, v2).text, v2);
});

test('parallel edits from a stale snapshot are still split correctly', () => {
  const base = lines('1', '2', '3', '4', '5', '6');
  const s = initialState(base);
  // A and B both read the base. A writes first; B's write lands on top of A's.
  const aDone = lines('1', 'two', '3', '4', '5', '6');
  const bDone = lines('1', 'two', '3', '4', 'five', '6');
  applyChange(s, A, base, aDone);
  applyChange(s, B, base, bDone);
  applyChange(s, UNATTRIBUTED, undefined, bDone);
  assert.deepEqual(owners(s), [A, B]);
  assert.equal(only(s, [A], base, bDone).text, aDone);
  assert.equal(only(s, [B], base, bDone).text, lines('1', '2', '3', '4', 'five', '6'));
});

test('a manual edit between agent edits stays unattributed', () => {
  const base = lines('1', '2', '3');
  const s = initialState(base);
  const manual = lines('1', 'mine', '3');
  const agent = lines('1', 'mine', '3', 'agent');
  applyChange(s, A, manual, agent); // the agent saw the manual edit already on disk
  applyChange(s, UNATTRIBUTED, undefined, agent);
  assert.deepEqual(owners(s), [A, UNATTRIBUTED].sort());
  assert.equal(only(s, [A], base, agent).text, lines('1', '2', '3', 'agent'));
  assert.equal(only(s, [UNATTRIBUTED], base, agent).text, manual);
});

test('reverting to the committed text leaves no owners', () => {
  const base = lines('a', 'b', 'c');
  const s = initialState(base);
  applyChange(s, A, base, lines('a', 'x', 'c', 'd'));
  applyChange(s, UNATTRIBUTED, undefined, base);
  assert.deepEqual(owners(s), []);
});

test("discarding one agent's lines keeps the other agent's", () => {
  const base = lines('1', '2', '3', '4');
  const s = initialState(base);
  const v1 = lines('1', 'two', '3', '4');
  const v2 = lines('1', 'two', '3', 'four', 'extra');
  applyChange(s, A, base, v1);
  applyChange(s, B, v1, v2);
  const withoutA = only(s, [B, UNATTRIBUTED], base, v2).text;
  assert.equal(withoutA, lines('1', '2', '3', 'four', 'extra'));
  applyChange(s, UNATTRIBUTED, undefined, withoutA); // what the next refresh sees after the discard
  assert.deepEqual(owners(s), [B]);
});

test('CRLF on disk vs LF in the repository is not a change', () => {
  const base = lines('a', 'b', 'c');
  const crlf = 'a\r\nB\r\nc\r\n';
  const s = initialState(base);
  applyChange(s, A, 'a\r\nb\r\nc\r\n', crlf);
  applyChange(s, UNATTRIBUTED, undefined, crlf);
  assert.deepEqual(owners(s), [A]);
  assert.equal(only(s, [A], base, crlf).text.replace(/\r/g, ''), lines('a', 'B', 'c'));
});

test('created and deleted files', () => {
  const created = initialState(null);
  applyChange(created, A, null, lines('new'));
  assert.deepEqual(owners(created), [A]);
  assert.deepEqual(only(created, [A], null, lines('new')), { exists: true, text: lines('new') });
  assert.equal(only(created, [B], null, lines('new')).exists, false);

  const base = lines('old');
  const deleted = initialState(base);
  applyChange(deleted, B, base, null);
  assert.deepEqual(owners(deleted), [B]);
  assert.equal(only(deleted, [B], base, null).exists, false);
  assert.deepEqual(only(deleted, [A], base, null), { exists: true, text: base });
});

test('committing one agent rebases the rest onto the new commit', () => {
  const base = lines('1', '2', '3', '4');
  const s = initialState(base);
  const v1 = lines('1', 'two', '3', '4');
  const v2 = lines('1', 'two', '3', 'four');
  applyChange(s, A, base, v1);
  applyChange(s, B, v1, v2);
  const next = commitOwners(s, (o) => o === A, base, v2)!;
  assert.deepEqual(owners(next), [B]);
  assert.equal(only(next, [], v1, v2).text, v1); // the new base is A's version
  assert.equal(only(next, [B], v1, v2).text, v2);
});

test('binary files are attributed whole-file', () => {
  const base = 'PNG\0one';
  const s = initialState(base);
  applyChange(s, A, base, 'PNG\0two');
  applyChange(s, UNATTRIBUTED, undefined, 'PNG\0two');
  assert.deepEqual(owners(s), [A]);
  assert.equal(only(s, [], base, 'PNG\0two').text, base);
});

test("an agent editing another agent's line: both views stay coherent", () => {
  // Same shape as a real run: one subagent adds multiply() and exports it, then the main
  // agent renames substract -> subtract, including in the line the subagent just changed.
  const base = lines('// substract', 'function substract() {}', '', 'module.exports = { substract };');
  const s = initialState(base);
  const v1 = lines('// substract', 'function substract() {}', 'function multiply() {}', '', 'module.exports = { substract, multiply };');
  applyChange(s, A, base, v1);
  const v2 = lines('// subtract', 'function subtract() {}', 'function multiply() {}', '', 'module.exports = { subtract, multiply };');
  applyChange(s, B, v1, v2);
  applyChange(s, UNATTRIBUTED, undefined, v2);

  assert.deepEqual(owners(s), [A, B]);
  assert.equal(only(s, [A], base, v2).text, v1);
  // B's view: its rename everywhere; the export line includes the multiply it built on.
  assert.equal(only(s, [B], base, v2).text, lines('// subtract', 'function subtract() {}', '', 'module.exports = { subtract, multiply };'));
  assert.equal(only(s, [A, B], base, v2).text, v2);
  assert.equal(only(s, [], base, v2).text, base);

  // Discarding B goes back to exactly A's version.
  const withoutB = { ...s, elems: s.elems.map((e) => ({ ...e })) };
  discardOwner(withoutB, B);
  assert.equal(liveText(withoutB), v1);
  assert.deepEqual(owners(withoutB), [A]);

  // Discarding A removes its independent function but keeps the line B built on.
  discardOwner(s, A);
  assert.equal(liveText(s), lines('// subtract', 'function subtract() {}', '', 'module.exports = { subtract, multiply };'));
});

test('committing the earlier agent of a shared line leaves the later agent its own change', () => {
  const base = lines('x = 1');
  const s = initialState(base);
  applyChange(s, A, base, lines('x = 2'));
  applyChange(s, B, lines('x = 2'), lines('x = 3'));
  const next = commitOwners(s, (o) => o === A, base, lines('x = 3'))!;
  assert.deepEqual(owners(next), [B]);
  assert.equal(only(next, [], lines('x = 2'), lines('x = 3')).text, lines('x = 2'));
  assert.equal(only(next, [B], lines('x = 2'), lines('x = 3')).text, lines('x = 3'));
});

test('a change reverted by another agent disappears', () => {
  const base = lines('a', 'b');
  const s = initialState(base);
  applyChange(s, A, base, lines('a', 'B'));
  applyChange(s, B, lines('a', 'B'), base);
  applyChange(s, UNATTRIBUTED, undefined, base);
  assert.deepEqual(owners(s), []);
});
