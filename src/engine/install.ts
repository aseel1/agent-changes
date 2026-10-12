// Registers the hook with Claude Code for one repository.
//
// The script is copied to a stable place (~/.claude/agent-changes/) so extension updates
// don't break the path, and registered in <repo>/.claude/settings.local.json, which Claude
// Code reads for that project and which is meant to stay out of git. Next to it go the guard
// it loads before git commands, the command agents run to act on their own changes (cli.js),
// and the engine both of them use.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git, GitError } from './git';

export const HOOK_FILE = 'agent-changes-hook.js';

const FILE_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
const SHELL_TOOLS = 'Bash|PowerShell';
const HOOKS: Record<string, string | undefined> = {
  PreToolUse: `${FILE_TOOLS}|${SHELL_TOOLS}`,
  PostToolUse: `${FILE_TOOLS}|${SHELL_TOOLS}|Agent|Task`,
  PostToolUseFailure: `${FILE_TOOLS}|${SHELL_TOOLS}`,
  UserPromptSubmit: undefined,
  SessionStart: undefined,
  Stop: undefined,
  SessionEnd: undefined,
};

/** The oldest Node.js the hook runs on. */
export const MIN_NODE = 18;

export function hookDir(home = os.homedir()): string {
  return path.join(home, '.claude', 'agent-changes');
}

export function hookDestination(home = os.homedir()): string {
  return path.join(hookDir(home), HOOK_FILE);
}

/**
 * The major version of the `node` that Claude Code will start the hook with (the one on PATH),
 * or 0 if there is none.
 */
export function nodeMajor(): Promise<number> {
  return new Promise((resolve) =>
    execFile('node', ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) =>
      resolve(err ? 0 : Number(/^v(\d+)/.exec(String(stdout).trim())?.[1] ?? 0)),
    ),
  );
}

/**
 * Whether Claude Code looks to be in use in any of these folders: they have Claude Code project
 * settings or a CLAUDE.md, or Claude Code keeps session history for them (in
 * ~/.claude/projects/, named after the folder with every other character turned into "-").
 */
export function claudeUsedIn(dirs: string[], configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): boolean {
  if (dirs.some((d) => fs.existsSync(path.join(d, '.claude')) || fs.existsSync(path.join(d, 'CLAUDE.md')))) return true;
  let projects: string[];
  try {
    projects = fs.readdirSync(path.join(configDir, 'projects'));
  } catch {
    return false;
  }
  // The drive letter's case depends on who started the session.
  const fold = (name: string) => (process.platform === 'win32' ? name.toLowerCase() : name);
  const known = new Set(projects.map(fold));
  return dirs.some((d) => known.has(fold(d.replace(/[^a-zA-Z0-9]/g, '-'))));
}

/**
 * Copies the hook and the files it loads from the extension into `dest`. Returns true if any
 * file changed. The hook goes last, so a new hook never starts without its new helpers.
 */
export function syncHookFiles(extensionRoot: string, dest = hookDir()): boolean {
  const out = path.join(extensionRoot, 'out');
  const files: Array<[string, string]> = [
    ...fs
      .readdirSync(path.join(out, 'engine'))
      .filter((f) => f.endsWith('.js'))
      .map((f): [string, string] => [path.join(out, 'engine', f), path.join('engine', f)]),
    [path.join(out, 'guard.js'), 'guard.js'],
    [path.join(out, 'cli.js'), 'cli.js'],
    [path.join(extensionRoot, 'hook', HOOK_FILE), HOOK_FILE],
  ];
  let changed = false;
  for (const [from, to] of files) changed = copyIfChanged(from, path.join(dest, to)) || changed;
  return changed;
}

function copyIfChanged(from: string, to: string): boolean {
  const next = fs.readFileSync(from);
  try {
    if (fs.readFileSync(to).equals(next)) return false;
  } catch {}
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Write aside, then rename: a hook starting meanwhile reads the old file or the new one.
  const tmp = `${to}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, to);
  return true;
}

interface HookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface MatcherEntry {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

/**
 * Adds (or refreshes) the hook entries in <repo>/.claude/settings.local.json. Returns the file
 * and whether it had to change.
 */
export function installHookSettings(repoRoot: string, hookPath = hookDestination()): { file: string; changed: boolean } {
  const file = path.join(repoRoot, '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};
  let before = '';
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      settings = JSON.parse(text); // a parse error stops us rather than clobbering the file
      before = JSON.stringify(settings);
    }
  }
  const command = `node "${hookPath.replace(/\\/g, '/')}"`;
  const hooks = (settings.hooks ??= {}) as Record<string, MatcherEntry[]>;
  for (const [event, matcher] of Object.entries(HOOKS)) {
    const existing = (hooks[event] ?? []).flatMap((m) => {
      const kept = (m.hooks ?? []).filter((h) => !String(h.command ?? '').includes(HOOK_FILE));
      if (kept.length === (m.hooks ?? []).length) return [m];
      return kept.length ? [{ ...m, hooks: kept }] : [];
    });
    existing.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 30 }] });
    hooks[event] = existing;
  }
  if (JSON.stringify(settings) === before) return { file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, changed: true };
}

/**
 * Keeps the settings file the hook is registered in out of commits. Claude Code usually ignores
 * it globally once it has written one itself; until then it goes in this repository's
 * .git/info/exclude, which is never committed either.
 */
export async function ignoreHookSettings(repoRoot: string): Promise<void> {
  const file = '.claude/settings.local.json';
  try {
    await git(repoRoot, ['check-ignore', '-q', file]);
    return; // already ignored
  } catch (e) {
    if (!(e instanceof GitError && e.code === 1)) return;
  }
  const exclude = path.resolve(repoRoot, (await git(repoRoot, ['rev-parse', '--git-path', 'info/exclude'])).toString('utf8').trim());
  let text = '';
  try {
    text = fs.readFileSync(exclude, 'utf8');
  } catch {}
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/${file}\n`);
}
