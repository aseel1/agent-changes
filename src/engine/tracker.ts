// Turns the hook's event log into "which agent owns which change", per repository.
//
// Storage lives in <git-dir>/agent-changes/ so it is never committed:
//   log.jsonl   events appended by the hook
//   blobs/      file versions referenced by the events
//   state.json  checkpoint written by the extension: the commit the ownership is relative
//               to, how much of the log is folded into it, and what is staged per agent

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { changedPaths, git, readBlobs } from './git';
import { TitleWatcher } from './titles';
import { dominantEol, isBinary, sameText, withEol } from './lines';
import {
  applyChange,
  cloneState,
  commitOwners,
  discardOwner,
  FileState,
  initialState,
  liveText,
  ownersOf,
  UNATTRIBUTED,
  Version,
  virtualVersion,
} from './model';

const MAX_BLOB = 8 * 1024 * 1024;
const ZERO_OID = '0'.repeat(40);

/** Number of distinct agent colors the UI offers. */
export const PALETTE_SIZE = 7;

export interface LogEvent {
  v: number;
  t: number;
  kind: 'file' | 'bash' | 'agent' | 'session' | 'discard';
  session: string;
  agent?: string | null;
  agentType?: string | null;
  tool?: string;
  file?: string;
  before?: string | null;
  after?: string | null;
  command?: string;
  ambiguous?: string[];
  description?: string | null;
  title?: string;
  /** For 'session': 'name' when Claude Code reported the session name, 'prompt' for prompt text. */
  source?: 'name' | 'prompt';
  parent?: string | null;
  /** For 'session': where Claude Code keeps the session transcript. */
  transcript?: string;
  /** For 'discard': whose changes were removed. */
  owner?: string;
}

export interface OwnerInfo {
  id: string;
  kind: 'main' | 'subagent' | 'unattributed';
  session: string;
  /** Index into the palette, -1 for unattributed. */
  color: number;
  label: string;
  /** Label without decoration, for editor titles. */
  name: string;
  agentType?: string;
  detail: string;
  firstSeen: number;
}

export interface FileEntry {
  path: string;
  state: FileState;
  /** Committed version (binary string), null if the file isn't in HEAD. */
  base: string | null;
  /** Version on disk (binary string), null if deleted. */
  disk: string | null;
  owners: string[];
  /** Owners whose changes the index holds. */
  staged: string[];
  /** Owners with changes that aren't in the index yet. */
  unstaged: string[];
}

export interface StagedItem {
  path: string;
  /** git's status letter for the staged change (A, M, D). */
  status: string;
  /** Whose changes are staged; empty when the index holds content Agent Changes can't attribute. */
  owners: string[];
  base: string | null;
  index: string | null;
}

export interface Snapshot {
  head: string | null;
  owners: OwnerInfo[];
  files: Map<string, FileEntry>;
  /** Everything in the index, merged across owners (like the Git view's Staged Changes). */
  staged: StagedItem[];
}

interface Persisted {
  version: 1;
  baseCommit: string | null;
  logOffset: number;
  files: Record<string, FileState>;
  staged: Record<string, string[]>;
  /** Index object id written when Agent Changes last staged each file. */
  stagedOid?: Record<string, string>;
  colors?: Record<string, number>;
}

interface SessionInfo {
  named?: string;
  prompted?: string;
  transcript?: string;
}

interface Log {
  entries: Array<{ offset: number; event: LogEvent }>;
  size: number;
}

export class StagedConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`The index already has other staged changes in: ${paths.join(', ')}`);
  }
}

export function ownerOf(e: { session: string; agent?: string | null }): string {
  return e.agent ? `${e.session}/${e.agent}` : e.session;
}

export class Tracker {
  readonly store: string;
  private readonly titles = new TitleWatcher();
  private sessions = new Map<string, SessionInfo>();

  private constructor(
    readonly root: string,
    readonly gitDir: string,
  ) {
    this.store = path.join(gitDir, 'agent-changes');
  }

  static async open(dir: string): Promise<Tracker | null> {
    try {
      const out = (await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])).toString('utf8');
      const [top, gitDir] = out.split(/\r?\n/);
      if (!top || !gitDir) return null;
      return new Tracker(realpath(top), path.normalize(gitDir));
    } catch {
      return null;
    }
  }

  get enabled(): boolean {
    return fs.existsSync(this.store);
  }

  enable(): void {
    fs.mkdirSync(this.store, { recursive: true });
  }

  /** Changes whenever something that affects the snapshot (other than plain file edits) changes. */
  signature(): string {
    const files = [
      path.join(this.store, 'log.jsonl'),
      path.join(this.store, 'state.json'),
      path.join(this.gitDir, 'index'),
      path.join(this.gitDir, 'HEAD'),
      path.join(this.gitDir, 'logs', 'HEAD'),
    ];
    return files
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return `${st.size}:${st.mtimeMs}`;
        } catch {
          return '-';
        }
      })
      .join('|');
  }

  // ------------------------------------------------------------- snapshot

  async compute(): Promise<Snapshot> {
    const head = await this.head();
    const log = this.readLog();
    let persisted = this.loadPersisted();
    if (!persisted) {
      persisted = fresh(head, 0);
      this.savePersisted(persisted);
    }
    if (persisted.logOffset > log.size) persisted.logOffset = 0; // log was truncated
    if (persisted.baseCommit !== head) {
      persisted = await this.rebase(persisted, head, log);
      this.savePersisted(persisted);
    }
    const files = await this.build(persisted, eventsFrom(log, persisted.logOffset));
    const staged = await this.attachIndex(files, persisted);
    const owners = this.describeOwners(log, files);
    if (this.assignColors(persisted, owners)) this.savePersisted(persisted);
    return { head, owners, files, staged };
  }

  /** The file with only the changes of the given owners applied. */
  version(entry: FileEntry, owners: Iterable<string>): Version {
    const set = new Set(owners);
    return virtualVersion(entry.state, (o) => set.has(o), entry.base, entry.disk);
  }

  private async build(p: Persisted, events: LogEvent[]): Promise<Map<string, FileEntry>> {
    const byFile = new Map<string, LogEvent[]>();
    for (const e of events) {
      if ((e.kind !== 'file' && e.kind !== 'bash' && e.kind !== 'discard') || !e.file) continue;
      let list = byFile.get(e.file);
      if (!list) byFile.set(e.file, (list = []));
      list.push(e);
    }
    const paths = new Set<string>([...byFile.keys(), ...Object.keys(p.files), ...(await changedPaths(this.root))]);
    const bases = await this.readAt(p.baseCommit, [...paths]);

    const result = new Map<string, FileEntry>();
    for (const rel of [...paths].sort()) {
      const base = bases.get(rel) ?? null;
      let state = p.files[rel] ? cloneState(p.files[rel]) : initialState(base);
      for (const e of byFile.get(rel) ?? []) {
        if (e.kind === 'discard') {
          if (e.owner && !discardOwner(state, e.owner)) state = initialState(base);
          continue;
        }
        const after = this.blob(e.after, true);
        if (after === undefined) continue;
        const before = 'before' in e ? this.blob(e.before, false) : undefined;
        applyChange(state, e.ambiguous?.length ? UNATTRIBUTED : ownerOf(e), before, after);
      }
      const disk = this.readDisk(rel);
      if (disk === undefined) continue;
      applyChange(state, UNATTRIBUTED, undefined, disk);

      const owners = ownersOf(state);
      if (!owners.size) continue;
      result.set(rel, {
        path: rel,
        state,
        base,
        disk,
        owners: [...owners],
        staged: [],
        unstaged: [...owners],
      });
    }
    return result;
  }

  /**
   * HEAD moved (commit, reset, checkout). Fold what was committed into the base and keep the
   * ownership of what is still uncommitted.
   */
  private async rebase(p: Persisted, head: string | null, log: Log): Promise<Persisted> {
    const built = await this.build(p, eventsFrom(log, p.logOffset));
    const newBases = await this.readAt(head, [...built.keys()]);
    const files: Record<string, FileState> = {};
    for (const [rel, entry] of built) {
      const target = newBases.get(rel) ?? null;
      const candidates = [new Set(p.staged[rel] ?? []), new Set<string>(), new Set(entry.owners), ...entry.owners.map((o) => new Set([o]))];
      let next: FileState | null = null;
      for (const set of candidates) {
        const include = (o: string) => set.has(o);
        const v = virtualVersion(entry.state, include, entry.base, entry.disk);
        if (v.exists === (target !== null) && (!v.exists || sameText(v.text, target))) {
          next = commitOwners(entry.state, include, entry.base, entry.disk);
          break;
        }
      }
      // Anything we can't explain starts over from the new HEAD (it shows as unattributed).
      if (next && ownersOf(next).size) files[rel] = next;
    }
    return { version: 1, baseCommit: head, logOffset: log.size, files, staged: {}, colors: p.colors };
  }

  /**
   * Works out what the index holds for each changed file: whose changes are staged (checked
   * against the index, so staging from the Git view counts too) and who still has unstaged
   * changes. Returns the staged files, merged across owners.
   */
  private async attachIndex(files: Map<string, FileEntry>, p: Persisted): Promise<StagedItem[]> {
    const cached = await this.cachedChanges();
    const blobs = await readBlobs(this.root, [...cached.values()].filter((c) => c.oid !== ZERO_OID).map((c) => c.oid));
    const orphans = [...cached.keys()].filter((rel) => !files.has(rel));
    const orphanBases = await this.readAt(p.baseCommit, orphans);

    for (const entry of files.values()) {
      entry.staged = [];
      entry.unstaged = [...entry.owners];
    }
    const items: StagedItem[] = [];
    for (const [rel, c] of cached) {
      const buf = c.oid === ZERO_OID ? null : blobs.get(c.oid) ?? null;
      const index: Version = { exists: buf !== null, text: buf ? buf.toString('latin1') : '' };
      const entry = files.get(rel);
      let owners: string[] = [];
      if (entry) {
        const hint = (p.staged[rel] ?? []).filter((o) => entry.owners.includes(o));
        if (hint.length && p.stagedOid?.[rel] === c.oid) {
          owners = hint; // exactly what Agent Changes staged, even if those owners edited since
        } else {
          const candidates = [hint, entry.owners, ...entry.owners.map((o) => [o])];
          owners = candidates.find((set) => set.length && sameVersion(this.version(entry, set), index)) ?? [];
        }
        entry.staged = owners;
        entry.unstaged = entry.owners.filter((o) => !sameVersion(this.version(entry, [...owners, o]), index));
      }
      items.push({
        path: rel,
        status: c.status,
        owners,
        base: entry ? entry.base : orphanBases.get(rel) ?? null,
        index: index.exists ? index.text : null,
      });
    }
    return items.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Files whose index entry differs from HEAD, with git's status letter and index object id. */
  private async cachedChanges(): Promise<Map<string, { status: string; oid: string }>> {
    const out = await git(this.root, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames']).catch(() => Buffer.alloc(0));
    const parts = out.toString('utf8').split('\0');
    const result = new Map<string, { status: string; oid: string }>();
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i].split(' '); // ":100644 100644 <src> <dst> M"
      if (meta.length < 5) continue;
      result.set(parts[i + 1], { status: meta[4][0], oid: meta[3] });
    }
    return result;
  }

  private describeOwners(log: Log, files: Map<string, FileEntry>): OwnerInfo[] {
    const used = new Set<string>();
    for (const f of files.values()) for (const o of f.owners) used.add(o);

    const sessions = new Map<string, SessionInfo>();
    const sessionInfo = (s: string) => sessions.get(s) ?? sessions.set(s, {}).get(s)!;
    const agents = new Map<string, { description?: string | null; agentType?: string | null }>();
    const firstSeen = new Map<string, number>();
    const types = new Map<string, string>();
    for (const { event: e } of log.entries) {
      if (e.kind === 'session') {
        const info = sessionInfo(e.session);
        if (e.transcript) info.transcript = e.transcript;
        if (!e.title) continue;
        if (e.source === 'name') info.named = e.title;
        // Older hook versions stored raw prompts; skip ones that start with injected markup.
        else if (!info.prompted && !e.title.startsWith('<')) info.prompted = e.title;
        continue;
      }
      if (e.kind === 'agent') {
        if (e.agent) agents.set(`${e.session}/${e.agent}`, e);
        continue;
      }
      const o = ownerOf(e);
      if (!firstSeen.has(o)) firstSeen.set(o, e.t);
      if (!firstSeen.has(e.session)) firstSeen.set(e.session, e.t);
      if (e.agent && e.agentType) types.set(o, e.agentType);
    }
    this.sessions = sessions;

    const sessionOf = (o: string) => o.split('/')[0];
    const infos: OwnerInfo[] = [];
    for (const id of used) {
      if (id === UNATTRIBUTED) {
        infos.push({
          id,
          kind: 'unattributed',
          session: '',
          label: 'Unattributed (you or other tools)',
          name: 'Unattributed',
          detail: 'Changes no agent event explains',
          firstSeen: Infinity,
          color: -1,
        });
        continue;
      }
      const [session, agent] = id.split('/');
      const o: OwnerInfo = { id, kind: agent ? 'subagent' : 'main', session, label: '', name: '', detail: '', firstSeen: firstSeen.get(id) ?? 0, color: -1 };
      if (agent) {
        const info = agents.get(id);
        o.agentType = info?.agentType ?? types.get(id) ?? 'subagent';
        o.label = info?.description ? `${clip(info.description, 50)} (${o.agentType})` : `${o.agentType} ${agent.slice(0, 7)}`;
        o.name = info?.description ? clip(info.description, 40) : `${o.agentType} ${agent.slice(0, 7)}`;
      }
      this.applyTitle(o);
      infos.push(o);
    }
    // Sessions in the order they started; each session's main agent, then its subagents.
    const sessionStart = (o: OwnerInfo) => (o.kind === 'unattributed' ? Infinity : firstSeen.get(sessionOf(o.id)) ?? 0);
    return infos.sort(
      (a, b) =>
        sessionStart(a) - sessionStart(b) ||
        sessionOf(a.id).localeCompare(sessionOf(b.id)) ||
        Number(a.kind === 'subagent') - Number(b.kind === 'subagent') ||
        a.firstSeen - b.firstSeen,
    );
  }

  /**
   * The session's current name: a rename read from its transcript, then a name a hook reported,
   * then the title Claude Code generated, then the first prompt.
   */
  private sessionTitle(session: string): string | undefined {
    const info = this.sessions.get(session);
    if (!info) return undefined;
    const fromFile = info.transcript ? this.titles.read(info.transcript) : undefined;
    return fromFile?.custom || info.named || fromFile?.generated || fromFile?.summary || info.prompted;
  }

  /** Sets the owner's session-dependent texts. Returns true if any changed. */
  private applyTitle(o: OwnerInfo): boolean {
    if (o.kind === 'unattributed') return false;
    const title = this.sessionTitle(o.session);
    const short = o.session.slice(0, 8);
    const before = `${o.label}\n${o.name}\n${o.detail}`;
    if (o.kind === 'main') {
      o.label = title ? clip(title, 60) : `Session ${short}`;
      o.name = title ? clip(title, 40) : `Session ${short}`;
      o.detail = `Main agent of session ${short}`;
    } else {
      o.detail = `${o.agentType} subagent of ${title ? `"${clip(title, 40)}"` : `session ${short}`}`;
    }
    return `${o.label}\n${o.name}\n${o.detail}` !== before;
  }

  /**
   * Re-reads session names (renames, generated titles) without recomputing changes. Cheap:
   * only what was appended to each transcript since the last call is read.
   */
  refreshTitles(snap: Snapshot): boolean {
    let changed = false;
    for (const o of snap.owners) changed = this.applyTitle(o) || changed;
    return changed;
  }

  /** Gives each owner a palette color that stays the same across refreshes. */
  private assignColors(p: Persisted, owners: OwnerInfo[]): boolean {
    const colors = (p.colors ??= {});
    const counts = new Array<number>(PALETTE_SIZE).fill(0);
    for (const o of owners) if (colors[o.id] !== undefined) counts[colors[o.id]]++;
    let changed = false;
    for (const o of owners) {
      if (o.kind === 'unattributed') continue;
      if (colors[o.id] === undefined) {
        colors[o.id] = counts.indexOf(Math.min(...counts));
        counts[colors[o.id]]++;
        changed = true;
      }
      o.color = colors[o.id];
    }
    return changed;
  }

  // ------------------------------------------------------------- actions

  /** Adds or removes `owner`'s changes in the index for the given files. */
  async setStaged(paths: string[], owner: string, stage: boolean, force = false): Promise<number> {
    const snap = await this.compute();
    const persisted = this.loadPersisted()!;
    const changes: Array<{ entry: FileEntry; next: Set<string> }> = [];
    const conflicts: string[] = [];
    for (const rel of paths) {
      const entry = snap.files.get(rel);
      if (!entry || !entry.owners.includes(owner)) continue;
      if (stage ? !entry.unstaged.includes(owner) : !entry.staged.includes(owner)) continue;
      const next = new Set(entry.staged);
      if (stage) next.add(owner);
      else next.delete(owner);
      // Staged content we can't attribute to anyone would be replaced.
      if (!entry.staged.length && snap.staged.some((s) => s.path === rel)) conflicts.push(rel);
      changes.push({ entry, next });
    }
    if (conflicts.length && !force) throw new StagedConflict(conflicts);

    const cleared = changes.filter((c) => !c.next.size).map((c) => c.entry.path);
    await this.resetIndex(cleared);
    const written = changes.filter((c) => c.next.size);
    const oids = await this.writeIndex(written.map(({ entry, next }) => ({ entry, version: this.version(entry, next) })), snap.head);
    const stagedOid = (persisted.stagedOid ??= {});
    for (const rel of cleared) {
      delete persisted.staged[rel];
      delete stagedOid[rel];
    }
    for (const { entry, next } of written) {
      persisted.staged[entry.path] = [...next];
      stagedOid[entry.path] = oids.get(entry.path) ?? ZERO_OID;
    }
    this.savePersisted(persisted);
    return changes.length;
  }

  /** Takes files out of the index entirely (back to HEAD), whoever staged them. */
  async unstagePaths(paths: string[]): Promise<void> {
    await this.resetIndex(paths);
    const persisted = this.loadPersisted();
    if (!persisted) return;
    for (const rel of paths) {
      delete persisted.staged[rel];
      delete persisted.stagedOid?.[rel];
    }
    this.savePersisted(persisted);
  }

  /** Rewrites the given files on disk without `owner`'s changes, keeping everyone else's. */
  async discard(paths: string[], owner: string): Promise<number> {
    let snap = await this.compute();
    const stagedHere = paths.filter((p) => snap.files.get(p)?.staged.includes(owner));
    if (stagedHere.length) {
      await this.setStaged(stagedHere, owner, false, true);
      snap = await this.compute();
    }
    const writes: Array<{ rel: string; text: string | null }> = [];
    for (const rel of paths) {
      const entry = snap.files.get(rel);
      if (!entry || !entry.owners.includes(owner)) continue;
      const state = cloneState(entry.state);
      const text = discardOwner(state, owner) ? liveText(state) : entry.base;
      writes.push({ rel, text: text === null || isBinary(text) ? text : withEol(text, dominantEol(entry.disk)) });
    }
    // Log first: the next refresh replays the discard, then finds the disk already matching.
    this.appendLog(writes.map(({ rel }) => ({ v: 1, t: Date.now(), kind: 'discard', session: '', file: rel, owner })));
    for (const { rel, text } of writes) {
      if (text === null) {
        this.removeFile(rel);
      } else {
        const abs = path.join(this.root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(text, 'latin1'));
      }
    }
    return writes.length;
  }

  /**
   * Discards every unstaged change in the given files, like Git's Discard All Changes: each
   * file goes back to what is staged for it, or to HEAD when nothing is, so staged changes stay.
   */
  async discardUnstaged(paths: string[]): Promise<number> {
    const snap = await this.compute();
    const t = Date.now();
    const events: LogEvent[] = [];
    const restore: string[] = [];
    const remove: string[] = [];
    for (const rel of paths) {
      const entry = snap.files.get(rel);
      if (!entry?.unstaged.length) continue;
      const item = snap.staged.find((s) => s.path === rel);
      const target = item ? item.index : entry.base;
      const state = cloneState(entry.state);
      let whole = false;
      for (const owner of entry.unstaged.filter((o) => !entry.staged.includes(o))) {
        if (!discardOwner(state, owner)) whole = true;
        events.push({ v: 1, t, kind: 'discard', session: '', file: rel, owner });
      }
      // What is left differs from the index when a staged owner edited the file again. Undo
      // those later edits in that owner's name, so its changes still match what is staged.
      const left = whole ? entry.base : liveText(state);
      const by = entry.staged.find((o) => entry.unstaged.includes(o)) ?? entry.staged[0];
      if (by && !whole && !sameText(left, target)) {
        const [session, agent = null] = by.split('/');
        events.push({ v: 1, t, kind: 'file', session, agent, tool: 'Discard', file: rel, before: this.putBlob(left), after: this.putBlob(target) });
      }
      (target === null ? remove : restore).push(rel);
    }
    this.appendLog(events);
    // git restores from the index, so line endings and filters come out as a checkout would.
    if (restore.length) await git(this.root, ['--literal-pathspecs', 'restore', '--worktree', '--', ...restore]);
    for (const rel of remove) this.removeFile(rel);
    return restore.length + remove.length;
  }

  async commit(message: string): Promise<void> {
    await git(this.root, ['commit', '-F', '-'], message);
  }

  /** Forgets all recorded ownership; current changes become unattributed. */
  async reset(): Promise<void> {
    fs.writeFileSync(path.join(this.store, 'log.jsonl'), '');
    for (const dir of ['blobs', 'sessions']) fs.rmSync(path.join(this.store, dir), { recursive: true, force: true });
    fs.rmSync(path.join(this.store, 'statcache.json'), { force: true });
    this.savePersisted(fresh(await this.head(), 0));
  }

  // ------------------------------------------------------------- plumbing

  private appendLog(events: LogEvent[]): void {
    if (events.length) fs.appendFileSync(path.join(this.store, 'log.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  }

  /** Stores a file version for a log event, the way the hook does. */
  private putBlob(text: string | null): string | null {
    if (text === null) return null;
    const buf = Buffer.from(text, 'latin1');
    const sha = createHash('sha1').update(buf).digest('hex');
    if (buf.length > MAX_BLOB) return `big:${sha}`;
    const file = path.join(this.store, 'blobs', sha.slice(0, 2), sha.slice(2));
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return sha;
  }

  /** Deletes a file, then any folders that only held it, as a checkout would. */
  private removeFile(rel: string): void {
    fs.rmSync(path.join(this.root, rel), { force: true });
    for (let dir = path.dirname(rel); dir !== '.' && dir !== ''; dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(path.join(this.root, dir)); // fails, and stops here, unless the folder is empty
      } catch {
        break;
      }
    }
  }

  /** Writes the given versions into the index. Returns the object id written per path. */
  private async writeIndex(items: Array<{ entry: FileEntry; version: Version }>, head: string | null): Promise<Map<string, string>> {
    const oids = new Map<string, string>();
    if (!items.length) return oids;
    const modes = await this.modes(items.map((i) => i.entry.path));
    const lines: string[] = [];
    for (const { entry, version } of items) {
      const rel = entry.path;
      if (!version.exists) {
        lines.push(`0 ${ZERO_OID}\t${rel}`);
        oids.set(rel, ZERO_OID);
        continue;
      }
      let oid: string;
      if (entry.state.opaqueOwner !== null && version.text !== entry.disk && head) {
        oid = (await git(this.root, ['rev-parse', `${head}:${rel}`])).toString('utf8').trim();
      } else if (entry.state.opaqueOwner !== null) {
        oid = (await git(this.root, ['hash-object', '-w', '--', rel])).toString('utf8').trim();
      } else {
        const bytes = Buffer.from(withEol(version.text, dominantEol(entry.disk ?? entry.base)), 'latin1');
        oid = (await git(this.root, ['hash-object', '-w', '--stdin', `--path=${rel}`], bytes)).toString('utf8').trim();
      }
      lines.push(`${modes.get(rel) ?? '100644'} ${oid}\t${rel}`);
      oids.set(rel, oid);
    }
    await git(this.root, ['update-index', '--index-info'], lines.join('\n') + '\n');
    return oids;
  }

  /** Puts files' index entries back to HEAD. */
  private async resetIndex(paths: string[]): Promise<void> {
    if (!paths.length) return;
    if (await this.head()) await git(this.root, ['restore', '--staged', '--', ...paths]);
    else await git(this.root, ['rm', '--cached', '-q', '--', ...paths]);
  }

  private async modes(paths: string[]): Promise<Map<string, string>> {
    const modes = new Map<string, string>();
    const out = (await git(this.root, ['ls-files', '-s', '-z', '--', ...paths]).catch(() => Buffer.alloc(0))).toString('utf8');
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab > 0) modes.set(entry.slice(tab + 1), entry.split(' ')[0]);
    }
    return modes;
  }

  private async head(): Promise<string | null> {
    try {
      return (await git(this.root, ['rev-parse', '--verify', '-q', 'HEAD'])).toString('utf8').trim() || null;
    } catch {
      return null;
    }
  }

  private async readAt(commit: string | null, paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!commit) return out;
    const blobs = await readBlobs(this.root, paths.map((p) => `${commit}:${p}`));
    for (const p of paths) {
      const b = blobs.get(`${commit}:${p}`);
      out.set(p, b ? b.toString('latin1') : null);
    }
    return out;
  }

  /** Disk content as a binary string, null if missing, undefined if not a regular file. */
  private readDisk(rel: string): string | null | undefined {
    const abs = path.join(this.root, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return undefined;
    const buf = fs.readFileSync(abs);
    if (buf.length > MAX_BLOB) return bigMarker(createHash('sha1').update(buf).digest('hex'));
    return buf.toString('latin1');
  }

  /** Content of a hook blob. Missing content is opaque for "after", unknown for "before". */
  private blob(id: string | null | undefined, isAfter: boolean): string | null | undefined {
    if (id === null) return null;
    if (id === undefined || id === '?') return undefined;
    if (id.startsWith('big:')) return bigMarker(id.slice(4));
    try {
      return fs.readFileSync(path.join(this.store, 'blobs', id.slice(0, 2), id.slice(2))).toString('latin1');
    } catch {
      return isAfter ? bigMarker(id) : undefined;
    }
  }

  private readLog(): Log {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(this.store, 'log.jsonl'));
    } catch {
      return { entries: [], size: 0 };
    }
    const entries: Log['entries'] = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break; // a line still being written
      try {
        entries.push({ offset: pos, event: JSON.parse(buf.subarray(pos, nl).toString('utf8')) });
      } catch {}
      pos = nl + 1;
    }
    return { entries, size: pos };
  }

  private loadPersisted(): Persisted | null {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.store, 'state.json'), 'utf8'));
      return p && p.version === 1 ? p : null;
    } catch {
      return null;
    }
  }

  private savePersisted(p: Persisted): void {
    const file = path.join(this.store, 'state.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(p));
    fs.renameSync(`${file}.tmp`, file);
  }
}

function sameVersion(a: Version, b: Version): boolean {
  return a.exists === b.exists && (!a.exists || sameText(a.text, b.text));
}

function fresh(head: string | null, logOffset: number): Persisted {
  return { version: 1, baseCommit: head, logOffset, files: {}, staged: {} };
}

function eventsFrom(log: Log, offset: number): LogEvent[] {
  return log.entries.filter((e) => e.offset >= offset).map((e) => e.event);
}

// A NUL byte makes the engine treat the content as binary (whole-file attribution).
function bigMarker(sha: string): string {
  return `\0large file ${sha}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
