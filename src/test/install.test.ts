// What Agent Changes checks before offering to turn itself on, and before saying it's ready.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { claudeUsedIn, ignoreHookSettings, MIN_NODE, nodeMajor } from '../engine/install';

test('notices Claude Code by its project files or its session history', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-changes-install-'));
  try {
    const config = path.join(tmp, 'config');
    const repo = (name: string) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      return dir;
    };
    fs.mkdirSync(path.join(config, 'projects'), { recursive: true });

    const plain = repo('plain');
    assert.equal(claudeUsedIn([plain], config), false);

    const withMd = repo('with-md');
    fs.writeFileSync(path.join(withMd, 'CLAUDE.md'), '# notes\n');
    assert.equal(claudeUsedIn([withMd], config), true);

    const withSettings = repo('with-settings');
    fs.mkdirSync(path.join(withSettings, '.claude'));
    assert.equal(claudeUsedIn([plain, withSettings], config), true);

    // Claude Code keeps history under the folder's path with every other character as "-".
    const used = repo('used.here');
    fs.mkdirSync(path.join(config, 'projects', used.replace(/[^a-zA-Z0-9]/g, '-')));
    assert.equal(claudeUsedIn([used], config), true);
    assert.equal(claudeUsedIn([used], path.join(tmp, 'no-config')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reads the version of the node on PATH', async () => {
  // The tests themselves run with node from PATH, so it is there and new enough.
  assert.ok((await nodeMajor()) >= MIN_NODE);
});

test('keeps the hook settings file out of commits, once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-changes-ignore-'));
  // Without the machine's own global ignore, which may already list the file.
  const xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}\n');
    const status = () => execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repo }).toString();
    assert.match(status(), /settings\.local\.json/);

    await ignoreHookSettings(repo);
    await ignoreHookSettings(repo);
    assert.equal(status(), '');
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((l) => l === '/.claude/settings.local.json').length, 1);
  } finally {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
