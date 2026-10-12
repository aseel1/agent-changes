// How the guard reads command lines: which git commands run, where, with which arguments.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { gitCalls } from '../guard';

const root = path.resolve('/repo');
const calls = (command: string, shell: 'bash' | 'powershell' = 'bash') =>
  gitCalls(command, root, shell).map((c) => [path.relative(root, c.cwd) || '.', c.sub, ...c.args]);

test('finds every git command in a chain, in the folder it runs in', () => {
  assert.deepEqual(calls('git status && git add -A; git commit -m "a; b (c)" | cat'), [
    ['.', 'status'],
    ['.', 'add', '-A'],
    ['.', 'commit', '-m', 'a; b (c)'],
  ]);
  assert.deepEqual(calls('cd sub && FOO=1 git -C deep -c core.x=y add .'), [[path.join('sub', 'deep'), 'add', '.']]);
  assert.deepEqual(calls('echo git add -A && npm test'), []);
});

test('drops redirections and keeps quoted text whole', () => {
  assert.deepEqual(calls('git add -A 2>&1 > /dev/null'), [['.', 'add', '-A']]);
  assert.deepEqual(calls("git commit -m \"$(cat <<'EOF'\nFix (dates); again\nEOF\n)\""), [['.', 'commit', '-m', "$(cat <<'EOF'\nFix (dates); again\nEOF\n)"]]);
  assert.deepEqual(calls('git add my\\ file.txt'), [['.', 'add', 'my file.txt']]);
});

test('reads PowerShell command lines too', () => {
  assert.deepEqual(calls('Set-Location sub; git.exe checkout -- C:\\repo\\a.txt', 'powershell'), [['sub', 'checkout', '--', 'C:\\repo\\a.txt']]);
});
