// Stops a Claude session's git command from sweeping up or erasing another session's
// uncommitted work in the same folder. The hook calls check() before Bash and PowerShell
// commands that mention git; when it returns a reason, the hook blocks the command and Claude
// reads the reason, which tells it how to act on its own changes only.
//
// Work counts as someone else's when it belongs to a different Claude session. A session's
// subagents are part of its own work, and changes made outside Claude (unattributed) aren't
// guarded: they are the user's, and the user is the one giving the instructions.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from './engine/git';
import { UNATTRIBUTED } from './engine/model';
import { OwnerInfo, Snapshot, Tracker } from './engine/tracker';

/** Put in front of a command to let it through anyway. */
export const ALLOW = 'AGENT_CHANGES_ALLOW=1';
const ALLOWED = /\bAGENT_CHANGES_ALLOW\s*=\s*['"]?1\b/;

export type Shell = 'bash' | 'powershell';

export interface GitCall {
  cwd: string;
  sub: string;
  args: string[];
}

/** What a git command would do to uncommitted work. */
interface Effect {
  action: 'stage' | 'erase' | 'stash';
  /** Whose changes it reaches: only what isn't staged yet, or staged changes too. */
  scope: 'unstaged' | 'all';
  /** Repository-relative files; a trailing '/' stands for everything under that folder. */
  paths: string[];
}

/** Returns why the command must not run, or null when it can. */
export async function check(command: string, cwd: string, session: string, cli: string, shell: Shell = 'bash'): Promise<string | null> {
  if (!session || ALLOWED.test(command)) return null;
  let tracker: Tracker | null | undefined;
  let snap: Snapshot | undefined;
  for (const call of gitCalls(command, cwd, shell)) {
    if (!RISKY.has(call.sub)) continue;
    tracker ??= await Tracker.open(call.cwd, { readOnly: true });
    if (!tracker?.enabled) return null;
    const fx = await effect(call, tracker.root);
    if (!fx?.paths.length) continue;
    snap ??= await tracker.compute();
    const hits = othersWork(snap, fx, session);
    if (hits.size) return explain(call, fx, hits, snap.owners, session, cli, shell);
  }
  return null;
}

// ---------------------------------------------------------------- reading the command line

/** The git commands in a command line, each with the folder it runs in. */
export function gitCalls(command: string, cwd: string, shell: Shell = 'bash'): GitCall[] {
  const calls: GitCall[] = [];
  let dir = cwd;
  for (const words of simpleCommands(command, shell)) {
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift(); // FOO=1 git …
    const name = words.length ? path.basename(words[0]).replace(/\.exe$/i, '').toLowerCase() : '';
    if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl') {
      const target = words.slice(1).find((w) => !w.startsWith('-'));
      if (target) dir = resolveDir(dir, target);
      continue;
    }
    if (name !== 'git') continue;
    let at = dir;
    let i = 1;
    for (; i < words.length && words[i].startsWith('-'); i++) {
      const w = words[i];
      if (w === '-C') at = resolveDir(at, words[++i] ?? '.');
      else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i++;
    }
    if (i < words.length) calls.push({ cwd: at, sub: words[i], args: words.slice(i + 1) });
  }
  return calls;
}

/**
 * Splits a command line into simple commands (at ; & | newlines and parentheses) made of
 * unquoted words, dropping redirections. Good enough for the git commands agents write; it
 * isn't a full shell parser.
 */
function simpleCommands(command: string, shell: Shell): string[][] {
  const escape = shell === 'powershell' ? '`' : '\\';
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(dropRedirections(words));
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === escape && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === escape && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === '&' && /[<>]$/.test(word)) {
      word += c; // 2>&1
    } else if (';&|()\r\n'.includes(c)) {
      endCommand();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

function dropRedirections(words: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (/^\d*[<>]+$/.test(words[i])) i++; // "> file": the target is the next word
    else if (!/^\d*[<>]/.test(words[i])) kept.push(words[i]); // ">file", "2>&1"
  }
  return kept;
}

function resolveDir(from: string, target: string): string {
  if (target === '~' || target.startsWith('~/')) return path.join(os.homedir(), target.slice(1));
  // Git Bash spells C:\x as /c/x.
  const drive = process.platform === 'win32' && /^\/([A-Za-z])(\/|$)/.exec(target);
  return path.resolve(from, drive ? `${drive[1]}:/${target.slice(3)}` : target);
}

interface Parsed {
  flags: Set<string>;
  values: Map<string, string>;
  /** Arguments that aren't options, before a `--`. */
  positional: string[];
  /** Everything after a `--`, or null without one. */
  afterDashes: string[] | null;
}

/**
 * Reads git-style options. `withValue` are short options whose value follows (attached or as
 * the next word); `attached` are short options whose optional value can only be attached.
 */
function parseArgs(args: string[], withValue = '', attached = '', longWithValue: string[] = []): Parsed {
  const p: Parsed = { flags: new Set(), values: new Map(), positional: [], afterDashes: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      p.afterDashes = args.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      p.flags.add(name);
      if (eq > 0) p.values.set(name, a.slice(eq + 1));
      else if (longWithValue.includes(name)) p.values.set(name, args[++i] ?? '');
    } else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const flag = `-${a[k]}`;
        p.flags.add(flag);
        if (withValue.includes(a[k])) {
          p.values.set(flag, a.slice(k + 1) || (args[++i] ?? ''));
          break;
        }
        if (attached.includes(a[k])) break;
      }
    } else {
      p.positional.push(a);
    }
  }
  return p;
}

// ---------------------------------------------------------------- what a command would touch

const RISKY = new Set(['add', 'commit', 'stash', 'reset', 'checkout', 'switch', 'restore', 'clean', 'rm']);

async function effect({ sub, args, cwd }: GitCall, root: string): Promise<Effect | null> {
  const any = (p: Parsed, ...flags: string[]) => flags.some((f) => p.flags.has(f));
  const pathsOf = (p: Parsed) => [...p.positional, ...(p.afterDashes ?? [])];
  const changed = (paths: string[]) => (paths.length ? listFiles(cwd, ['ls-files', '-z', '-m', '-d', '--full-name', '--', ...paths]) : listFiles(root, ['ls-files', '-z', '-m', '-d']));
  const staged = (paths: string[]) => listFiles(paths.length ? cwd : root, ['diff', '--cached', '--name-only', '-z', '--', ...paths]);
  const everything = async () => union(await changed([]), await staged([]));
  const erase = (paths: string[], scope: Effect['scope'] = 'all'): Effect => ({ action: 'erase', scope, paths });

  switch (sub) {
    case 'add': {
      const p = parseArgs(args, '', '', ['--chmod', '--pathspec-from-file']);
      if (any(p, '-n', '--dry-run', '-p', '--patch', '-i', '--interactive', '-e', '--edit', '-N', '--intent-to-add', '--refresh', '-h', '--help')) return null;
      const out = await gitText(cwd, ['add', '--dry-run', ...args]);
      const paths = out.split('\n').flatMap((l) => /^(?:add|remove) '(.*)'$/.exec(l)?.[1] ?? []);
      return { action: 'stage', scope: 'unstaged', paths };
    }
    case 'commit': {
      const p = parseArgs(args, 'mFCct', 'uS', ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--template', '--cleanup', '--trailer']);
      if (any(p, '-p', '--patch', '--interactive', '--dry-run', '-h', '--help')) return null;
      const paths = pathsOf(p);
      if (paths.length) return { action: 'stage', scope: 'unstaged', paths: await changed(paths) };
      if (any(p, '-a', '--all')) return { action: 'stage', scope: 'unstaged', paths: await changed([]) };
      return null;
    }
    case 'stash': {
      const mode = !args.length || args[0].startsWith('-') ? 'push' : args[0];
      if (mode !== 'push' && mode !== 'save') return null;
      const p = parseArgs(args[0] === mode ? args.slice(1) : args, 'm', '', ['--message', '--pathspec-from-file']);
      if (any(p, '-p', '--patch', '-h', '--help')) return null;
      const paths = mode === 'push' ? pathsOf(p) : [];
      if (any(p, '-S', '--staged')) return { action: 'stash', scope: 'all', paths: await staged(paths) };
      let files = union(await changed(paths), await staged(paths));
      if (any(p, '-u', '--include-untracked', '-a', '--all')) {
        const ignored = any(p, '-a', '--all') ? [] : ['--exclude-standard'];
        files = union(files, await listFiles(paths.length ? cwd : root, ['ls-files', '-z', '-o', '--full-name', ...ignored, '--', ...paths]));
      }
      return { action: 'stash', scope: any(p, '-k', '--keep-index') ? 'unstaged' : 'all', paths: files };
    }
    case 'reset': {
      const p = parseArgs(args);
      return any(p, '--hard') ? erase(await everything()) : null;
    }
    case 'checkout': {
      const p = parseArgs(args, 'bB', '', ['--orphan', '--conflict', '--pathspec-from-file']);
      if (any(p, '-p', '--patch', '-h', '--help')) return null;
      const force = any(p, '-f', '--force');
      if (p.afterDashes) {
        const fromTree = p.positional.length > 0;
        const paths = p.afterDashes;
        return erase(fromTree ? union(await changed(paths), await staged(paths)) : await changed(paths), fromTree ? 'all' : 'unstaged');
      }
      if (any(p, '-b', '-B', '--orphan') || !p.positional.length) return force ? erase(await everything()) : null;
      if (await isCommit(cwd, p.positional[0])) {
        const paths = p.positional.slice(1);
        if (paths.length) return erase(union(await changed(paths), await staged(paths)));
        return force ? erase(await everything()) : null; // switching branches keeps local changes
      }
      return erase(await changed(p.positional), 'unstaged');
    }
    case 'switch': {
      const p = parseArgs(args, 'cC');
      return any(p, '-f', '--force', '--discard-changes') ? erase(await everything()) : null;
    }
    case 'restore': {
      const p = parseArgs(args, 's', '', ['--source', '--conflict', '--pathspec-from-file']);
      if (any(p, '-p', '--patch', '-h', '--help')) return null;
      const toIndex = any(p, '-S', '--staged');
      if (toIndex && !any(p, '-W', '--worktree')) return null; // only unstages
      const paths = pathsOf(p);
      if (!paths.length) return null;
      const all = toIndex || any(p, '-s', '--source');
      return erase(all ? union(await changed(paths), await staged(paths)) : await changed(paths), all ? 'all' : 'unstaged');
    }
    case 'clean': {
      const p = parseArgs(args, 'e', '', ['--exclude']);
      if (any(p, '-n', '--dry-run', '-i', '--interactive', '-h', '--help') || !any(p, '-f', '--force')) return null;
      const dry = ['clean', '-n', ...['-d', '-x', '-X'].filter((f) => p.flags.has(f))];
      for (const key of ['-e', '--exclude']) if (p.values.has(key)) dry.push('-e', p.values.get(key)!);
      const out = await gitText(cwd, [...dry, '--', ...pathsOf(p)]);
      const here = realpath(cwd); // root is the long, canonical spelling; cwd may be 8.3
      const paths = out.split('\n').flatMap((l) => {
        const m = /^Would remove (.*)$/.exec(l);
        if (!m) return [];
        const rel = path.relative(root, path.resolve(here, m[1])).split(path.sep).join('/');
        return [m[1].endsWith('/') ? `${rel}/` : rel];
      });
      return erase(paths, 'unstaged');
    }
    case 'rm': {
      const p = parseArgs(args, '', '', ['--pathspec-from-file']);
      if (any(p, '--cached', '-n', '--dry-run', '-h', '--help') || !any(p, '-f', '--force')) return null;
      const paths = pathsOf(p);
      return paths.length ? erase(union(await changed(paths), await staged(paths))) : null;
    }
  }
  return null;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    return (await git(cwd, ['-c', 'core.quotePath=false', ...args])).toString('utf8').replace(/\r/g, '');
  } catch {
    return ''; // a pathspec git rejects: the command itself will fail too
  }
}

async function listFiles(cwd: string, args: string[]): Promise<string[]> {
  return (await gitText(cwd, args)).split('\0').filter(Boolean);
}

async function isCommit(cwd: string, name: string): Promise<boolean> {
  return (await gitText(cwd, ['rev-parse', '--verify', '-q', `${name}^{commit}`])).trim() !== '';
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

// ---------------------------------------------------------------- whose work it is

function sessionOf(owner: string): string {
  return owner.split('/')[0];
}

/** Other sessions' owners with changes the effect reaches, each with its files. */
function othersWork(snap: Snapshot, fx: Effect, session: string): Map<string, string[]> {
  const files = new Set(fx.paths);
  const dirs = fx.paths.filter((p) => p.endsWith('/'));
  const hits = new Map<string, string[]>();
  for (const entry of snap.files.values()) {
    if (!files.has(entry.path) && !dirs.some((d) => entry.path.startsWith(d))) continue;
    for (const owner of fx.scope === 'unstaged' ? entry.unstaged : entry.owners) {
      if (owner === UNATTRIBUTED || sessionOf(owner) === session) continue;
      const list = hits.get(owner) ?? [];
      list.push(entry.path);
      hits.set(owner, list);
    }
  }
  return hits;
}

function explain(call: GitCall, fx: Effect, hits: Map<string, string[]>, owners: OwnerInfo[], session: string, cli: string, shell: Shell): string {
  const shown = clip(['git', call.sub, ...call.args].map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(' '), 80);
  const verb = { stage: 'stage', erase: 'erase', stash: 'stash away' }[fx.action];
  const run = `node "${cli.replace(/\\/g, '/')}"`;
  const lines = [
    `Agent Changes blocked this command, so none of it ran: \`${shown}\` would ${verb} uncommitted work that another Claude session made in this folder:`,
  ];
  for (const [owner, files] of hits) lines.push(`- ${describe(owner, owners)}: ${listed(files)}`);
  lines.push('');
  if (fx.action === 'stage') {
    lines.push(
      "To stage only this session's changes (only your lines, even in files the other session changed too), run:",
      `  ${run} stage --session ${session}`,
      'then commit without -a and without file names: git commit -m "<message>"',
    );
  } else {
    lines.push("To undo only this session's changes and keep the other session's, run:", `  ${run} discard --session ${session} [files...]`);
    if (fx.action === 'stash') lines.push('If you need a clean copy of the code, use a separate worktree (git worktree add) instead.');
  }
  const how = shell === 'powershell' ? `start the command with $env:AGENT_CHANGES_ALLOW=1;` : `put ${ALLOW} in front of the command`;
  lines.push('', `Leave the other session's work alone unless the user asks you to include it. If they do, ${how}.`);
  return lines.join('\n');
}

function describe(owner: string, owners: OwnerInfo[]): string {
  const o = owners.find((x) => x.id === owner);
  if (!o) return `session ${sessionOf(owner).slice(0, 8)}`;
  return o.kind === 'subagent' ? `"${o.name}" (a ${o.agentType} subagent of another session)` : `"${o.name}" (another session)`;
}

function listed(files: string[]): string {
  const shown = files.slice(0, 6).join(', ');
  return files.length > 6 ? `${shown} and ${files.length - 6} more` : shown;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
