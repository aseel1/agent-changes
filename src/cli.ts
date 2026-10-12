// Lets an agent act on its own session's changes only, the way the Source Control buttons do
// for one agent's group. The guard's messages point agents here:
//
//   node cli.js status  --session <id>             what is this session's, what is others'
//   node cli.js stage   --session <id> [files...]  stage only this session's lines
//   node cli.js discard --session <id> [files...]  undo only this session's changes
//
// A session's subagents count as the session. Files are relative to the current folder; a
// folder covers everything under it, and no files means every file the session changed.

import * as fs from 'fs';
import * as path from 'path';
import { UNATTRIBUTED } from './engine/model';
import { FileEntry, OwnerInfo, StagedConflict, Tracker } from './engine/tracker';

const USAGE = `usage: node cli.js <status|stage|discard> --session <session id> [files...]`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let session = '';
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--session') session = rest[++i] ?? '';
    else if (rest[i].startsWith('--session=')) session = rest[i].slice('--session='.length);
    else files.push(rest[i]);
  }
  if (!['status', 'stage', 'discard'].includes(command) || !session) {
    console.error(USAGE);
    return 2;
  }
  const tracker = await Tracker.open(process.cwd());
  if (!tracker?.enabled) {
    console.error('Agent Changes is not turned on for this repository.');
    return 1;
  }
  const mine = (o: string) => o === session || o.startsWith(`${session}/`);
  const wanted = files.map((f) => repoPath(tracker.root, f));
  const inScope = (e: FileEntry) => !wanted.length || wanted.some((w) => e.path === w || e.path.startsWith(`${w}/`));

  const snap = await tracker.compute();
  const entries = [...snap.files.values()].filter(inScope);
  const others = (e: FileEntry) => e.owners.filter((o) => !mine(o));

  if (command === 'status') {
    const own = entries.filter((e) => e.owners.some(mine));
    if (!own.length) console.log('This session has no uncommitted changes.');
    else {
      console.log("This session's changes:");
      for (const e of own) {
        const staged = e.staged.some(mine);
        const unstaged = e.unstaged.some(mine);
        console.log(`  ${e.path}  (${staged && unstaged ? 'partly staged' : staged ? 'staged' : 'not staged'})`);
      }
    }
    const byOwner = new Map<string, string[]>();
    for (const e of entries) for (const o of others(e)) byOwner.set(o, [...(byOwner.get(o) ?? []), e.path]);
    if (byOwner.size) {
      console.log("\nOther agents' changes (leave these alone):");
      for (const [o, paths] of byOwner) console.log(`  ${describe(o, snap.owners)}: ${paths.join(', ')}`);
    }
    return 0;
  }

  if (command === 'stage') {
    const owners = [...new Set(entries.flatMap((e) => e.unstaged.filter(mine)))];
    if (!owners.length) {
      console.log('Nothing to stage: this session has no unstaged changes here.');
      return 0;
    }
    const done = new Set<string>();
    try {
      for (const o of owners) {
        const paths = entries.filter((e) => e.unstaged.includes(o)).map((e) => e.path);
        await tracker.setStaged(paths, o, true);
        for (const p of paths) done.add(p);
      }
    } catch (e) {
      if (!(e instanceof StagedConflict)) throw e;
      console.error(`The index already holds changes in ${e.paths.join(', ')} that Agent Changes can't credit to anyone. Ask the user, or unstage them first: git restore --staged <file>`);
      return 1;
    }
    console.log(`Staged this session's changes in: ${[...done].join(', ')}`);
    const shared = entries.filter((e) => done.has(e.path) && others(e).length).map((e) => e.path);
    if (shared.length) console.log(`Other agents' changes in ${shared.join(', ')} stay unstaged.`);
    console.log('Commit them without -a and without file names (either would add everything in those files): git commit -m "<message>"');
    return 0;
  }

  const owners = [...new Set(entries.flatMap((e) => e.owners.filter(mine)))];
  if (!owners.length) {
    console.log('Nothing to undo: this session has no uncommitted changes here.');
    return 0;
  }
  const undone = new Set<string>();
  for (const o of owners) {
    const paths = entries.filter((e) => e.owners.includes(o)).map((e) => e.path);
    await tracker.discard(paths, o);
    for (const p of paths) undone.add(p);
  }
  console.log(`Undid this session's changes in: ${[...undone].join(', ')}`);
  const kept = entries.filter((e) => undone.has(e.path) && others(e).length).map((e) => e.path);
  if (kept.length) console.log(`Other agents' changes in ${kept.join(', ')} were kept.`);
  return 0;
}

function describe(owner: string, owners: OwnerInfo[]): string {
  if (owner === UNATTRIBUTED) return 'Unattributed (the user or other tools)';
  const o = owners.find((x) => x.id === owner);
  return o ? `"${o.name}"${o.kind === 'subagent' ? ` (${o.agentType} subagent)` : ''}` : owner;
}

/** A path given on the command line, relative to the repository root with forward slashes. */
function repoPath(root: string, given: string): string {
  const abs = path.resolve(given);
  let real = abs;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); // a deleted file
    } catch {}
  }
  return path.relative(root, real).split(path.sep).join('/').replace(/\/$/, '');
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`Agent Changes: ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  },
);
