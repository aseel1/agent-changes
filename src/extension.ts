import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hookDestination, installHookSettings, syncHookScript } from './engine/install';
import { toDisplay } from './engine/lines';
import { FileEntry, OwnerInfo, Snapshot, StagedConflict, StagedItem, Tracker } from './engine/tracker';
import { AGENT_FOLDER_MARK, AgentIconTheme, DotColor } from './iconTheme';

/** Zero-width characters used as digits in the per-agent folder marks. */
const MARK_DIGITS = ['\u200c', '\u200d', '\u2060', '\u2061'];

const SCHEME = 'agent-changes';
const DECORATION_QUERY = 'agent-changes-color';
/** Owner value in content URIs that asks for the staged (index) version. */
const INDEX = '@index';

/** One dot and one theme color (contributed in package.json) per agent. */
const PALETTE = [
  { dot: '🔵', color: 'agentChanges.blue' },
  { dot: '🟢', color: 'agentChanges.green' },
  { dot: '🟣', color: 'agentChanges.purple' },
  { dot: '🟠', color: 'agentChanges.orange' },
  { dot: '🟡', color: 'agentChanges.yellow' },
  { dot: '🔴', color: 'agentChanges.red' },
  { dot: '🟤', color: 'agentChanges.brown' },
];
const UNATTRIBUTED_STYLE = { dot: '⚪', color: 'agentChanges.unattributed' };

function styleOf(color: number) {
  return color >= 0 ? PALETTE[color % PALETTE.length] : UNATTRIBUTED_STYLE;
}

function style(o: OwnerInfo) {
  return styleOf(o.color);
}

/**
 * The agent's name as a path segment. Every row carries it as its first folder: in tree view
 * (… → View as Tree) each agent becomes a collapsible folder inside Changes and Staged Changes,
 * shown with the agent's colored dot (see iconTheme.ts); in list view the agent shows where Git
 * shows the folder. The invisible mark keeps these names apart from real folders.
 */
function agentFolder(prefix: string, name: string): string {
  return prefix + name.replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/, '');
}

/**
 * An invisible prefix unique to one agent in one group. Every folder level under the agent
 * carries it, so the icon theme's rules for this agent's folders can't match any other folder,
 * real or another agent's. (VS Code sorts the agents by name: its collator skips these marks,
 * and the characters it doesn't skip all take up visible space.)
 */
function folderMark(n: number): string {
  let digits = '';
  for (let i = 0; i < 4; i++, n = Math.floor(n / 4)) digits = MARK_DIGITS[n % 4] + digits;
  return AGENT_FOLDER_MARK + digits;
}

/** Colors each agent's file rows and shows A/M/D in the agent's color. */
class AgentDecorations implements vscode.FileDecorationProvider {
  /** Run the first time one of our rows is drawn, i.e. once the Source Control panel is open. */
  readonly onFirstRow: Array<() => void> = [];

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !uri.query.startsWith(DECORATION_QUERY)) return undefined;
    for (const fn of this.onFirstRow.splice(0)) fn();
    const q = new URLSearchParams(uri.query);
    const raw = q.get(DECORATION_QUERY) ?? '-1';
    const color = raw === 'none' ? undefined : new vscode.ThemeColor(styleOf(Number(raw)).color);
    return { badge: q.get('status') ?? undefined, color, tooltip: q.get('tip') ?? undefined, propagate: false };
  }
}

let output: vscode.OutputChannel;

interface AgentResource extends vscode.SourceControlResourceState {
  view: RepoView;
  path: string;
  /** The agent whose changes the row shows; '' for rows in Staged Changes. */
  owner: string;
  staged?: boolean;
}

/** Serves "the file at HEAD" and "the file with only one agent's changes" to the diff editor. */
class ContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly manager: Manager) {}

  uri(view: RepoView, rel: string, owner: string | null): vscode.Uri {
    const file = vscode.Uri.file(path.join(view.root, rel));
    return file.with({ scheme: SCHEME, query: JSON.stringify({ root: view.tracker.root, rel, owner }) });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { root, rel, owner } = JSON.parse(uri.query) as { root: string; rel: string; owner: string | null };
    const view = this.manager.views.get(root);
    const entry = view?.snapshot?.files.get(rel);
    const staged = view?.snapshot?.staged.find((s) => s.path === rel);
    if (!view) return '';
    if (owner === null) return toDisplay(entry ? entry.base : staged?.base ?? null);
    if (owner === INDEX) return toDisplay(staged?.index ?? null);
    return entry ? toDisplay(view.tracker.version(entry, [owner]).text) : '';
  }

  refresh(view: RepoView): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== SCHEME) continue;
      try {
        if (JSON.parse(doc.uri.query).root === view.tracker.root) this.emitter.fire(doc.uri);
      } catch {}
    }
  }
}

class RepoView implements vscode.Disposable {
  readonly scm: vscode.SourceControl;
  /** Everything in the index, like the Git view's Staged Changes. */
  readonly stagedGroup: vscode.SourceControlResourceGroup;
  /** Everything not staged yet, each row under the agent that made it. */
  readonly changesGroup: vscode.SourceControlResourceGroup;
  snapshot: Snapshot | undefined;
  /** Agent folder names on screen, with their dot colors (for the icon theme). */
  agentFolders = new Map<string, DotColor>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly poller: NodeJS.Timeout;
  private debounce: NodeJS.Timeout | undefined;
  private signature = '';
  private running = false;
  private rerun = false;

  constructor(
    readonly tracker: Tracker,
    /** The repository root spelled the way the workspace folder spells it. */
    readonly root: string,
    private readonly content: ContentProvider,
    private readonly onRendered: () => void,
  ) {
    this.scm = vscode.scm.createSourceControl('agentChanges', 'Agent Changes', vscode.Uri.file(root));
    this.scm.inputBox.placeholder = 'Message (Ctrl+Enter to commit what you staged here)';
    this.scm.acceptInputCommand = { command: 'agentChanges.commit', title: 'Commit', arguments: [this] };
    this.scm.count = 0; // the Git view already counts these files
    this.disposables.push(this.scm);
    this.stagedGroup = this.scm.createResourceGroup('staged', 'Staged Changes');
    this.stagedGroup.hideWhenEmpty = true;
    this.changesGroup = this.scm.createResourceGroup('changes', 'Changes');
    this.changesGroup.hideWhenEmpty = true;
    this.disposables.push(this.stagedGroup, this.changesGroup);

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
    const onFs = (uri: vscode.Uri) => {
      if (!/[\\/]\.git([\\/]|$)/.test(uri.fsPath)) this.schedule();
    };
    watcher.onDidChange(onFs, null, this.disposables);
    watcher.onDidCreate(onFs, null, this.disposables);
    watcher.onDidDelete(onFs, null, this.disposables);
    this.disposables.push(watcher);

    // The hook writes inside .git, which file watchers usually skip; poll a few stats instead.
    this.poller = setInterval(() => {
      const sig = tracker.signature();
      if (sig !== this.signature) {
        this.signature = sig;
        this.schedule(50);
      } else if (this.snapshot && !this.running) {
        // Renames land in session transcripts without any hook firing; relabel when one does.
        try {
          if (tracker.refreshTitles(this.snapshot)) this.render(this.snapshot);
        } catch (e) {
          output.appendLine(`title refresh failed: ${e}`);
        }
      }
    }, 1500);
  }

  schedule(delay = 400): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), delay);
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        this.snapshot = await this.tracker.compute();
        this.render(this.snapshot);
        this.content.refresh(this);
      } while (this.rerun);
    } catch (e) {
      output.appendLine(`[${new Date().toISOString()}] refresh failed: ${(e as Error).stack ?? e}`);
    } finally {
      this.running = false;
    }
  }

  ownerLabel(id: string): string {
    const o = this.snapshot?.owners.find((x) => x.id === id);
    return o ? `${style(o).dot} ${o.label}` : id;
  }

  /** Files where `owner` has changes that aren't staged yet. */
  filesOf(owner: string): string[] {
    return [...(this.snapshot?.files.values() ?? [])].filter((f) => f.unstaged.includes(owner)).map((f) => f.path);
  }

  render(snap: Snapshot): void {
    const files = [...snap.files.values()];
    this.agentFolders = new Map();
    let n = 0;
    const changes: AgentResource[] = [];
    for (const o of snap.owners) {
      const mine = files.filter((f) => f.unstaged.includes(o.id));
      if (!mine.length) continue;
      const folder = this.agentFolderFor(folderMark(n++), [o], mine.map((f) => f.path));
      changes.push(...mine.map((f) => this.resource(f, o, folder)));
    }
    this.changesGroup.resourceStates = changes;
    // Staged files sit together under their real folders, as in the Git view.
    this.stagedGroup.resourceStates = snap.staged.map((item) => this.stagedResource(item));
    this.onRendered();
  }

  /**
   * The agent's folder (its first path segment and the mark for the levels below), and the icon
   * theme rules that put its dot on the row VS Code draws for it. When all of an agent's files
   * sit in one folder chain, VS Code merges the agent row with that chain and takes the icon from
   * the chain's last folder, so that folder gets the dot too.
   */
  private agentFolderFor(prefix: string, owners: OwnerInfo[], paths: string[]): { prefix: string; name: string } {
    const name = agentFolder(prefix, owners.length ? owners.map((o) => o.label).join(' + ') : 'Unknown origin');
    const color: DotColor = owners.length === 1 ? owners[0].color : owners.length ? -2 : -1;
    this.agentFolders.set(name, color);
    const dirs = paths.map((p) => p.split('/').slice(0, -1));
    const chain = [name];
    for (let k = 0; dirs.every((d) => d.length > k) && new Set(dirs.map((d) => d[k])).size === 1; k++) {
      chain.push(prefix + dirs[0][k]);
    }
    if (chain.length > 1) this.agentFolders.set(`${chain[chain.length - 2]}/${chain[chain.length - 1]}`, color);
    return { prefix, name };
  }

  /** Where a row sits: the agent folder, then the file's real folders (marked), then its name. */
  private rowUri(folder: { prefix: string; name: string }, rel: string): vscode.Uri {
    const parts = rel.split('/');
    return vscode.Uri.file(path.join(this.root, folder.name, ...parts.slice(0, -1).map((p) => folder.prefix + p), parts[parts.length - 1]));
  }

  private stagedResource(item: StagedItem): AgentResource {
    // The origin is only in the tooltip; the row itself looks like the Git view's.
    const tooltip = item.owners.length
      ? `Staged from ${item.owners.map((id) => this.ownerLabel(id)).join(', ')}`
      : 'Staged outside Agent Changes, from an unknown origin';
    const res: { -readonly [K in keyof AgentResource]: AgentResource[K] } = {
      resourceUri: vscode.Uri.file(path.join(this.root, item.path)).with({
        query: `${DECORATION_QUERY}=none&status=${item.status}&staged&tip=${encodeURIComponent(tooltip)}`,
      }),
      decorations: { tooltip, strikeThrough: item.status === 'D', faded: false },
      contextValue: 'staged',
      view: this,
      path: item.path,
      owner: '',
      staged: true,
    };
    res.command = { command: 'agentChanges.openDiff', title: 'Open Staged Changes', arguments: [res] };
    return res;
  }

  private resource(f: FileEntry, o: OwnerInfo, folder: { prefix: string; name: string }): AgentResource {
    const partlyStaged = f.staged.includes(o.id);
    const mine = this.tracker.version(f, [o.id]);
    const deleted = f.base !== null && !mine.exists;
    const created = f.base === null && mine.exists;
    const others = f.owners.filter((x) => x !== o.id).map((x) => this.ownerLabel(x));
    const tooltip = [
      `${created ? 'Added' : deleted ? 'Deleted' : 'Modified'} by ${this.ownerLabel(o.id)}`,
      o.detail,
      partlyStaged ? 'Some of these changes are already staged' : '',
      others.length ? `Also changed by: ${others.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    // The query makes the row's URI unique to this agent, so the decoration provider can color
    // it (and the Git extension's own letters stay off it).
    const status = created ? 'A' : deleted ? 'D' : 'M';
    const res: { -readonly [K in keyof AgentResource]: AgentResource[K] } = {
      resourceUri: this.rowUri(folder, f.path).with({
        query: `${DECORATION_QUERY}=${o.color}&status=${status}&tip=${encodeURIComponent(tooltip.split('\n')[0])}`,
      }),
      decorations: { tooltip, strikeThrough: deleted, faded: false },
      contextValue: 'change',
      view: this,
      path: f.path,
      owner: o.id,
    };
    res.command = { command: 'agentChanges.openDiff', title: 'Open Changes', arguments: [res] };
    return res;
  }

  dispose(): void {
    clearInterval(this.poller);
    clearTimeout(this.debounce);
    for (const d of this.disposables) d.dispose();
  }
}

class Manager implements vscode.Disposable {
  readonly views = new Map<string, RepoView>();
  readonly content = new ContentProvider(this);

  constructor(private readonly onFolders: (folders: Map<string, DotColor>) => void) {}

  /** Tells the icon theme about every agent folder on screen, across repositories. */
  foldersChanged(): void {
    const all = new Map<string, DotColor>();
    for (const v of this.views.values()) for (const [name, color] of v.agentFolders) all.set(name, color);
    this.onFolders(all);
  }

  async scan(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const tracker = await Tracker.open(folder.uri.fsPath);
      if (!tracker?.enabled || this.views.has(tracker.root)) continue;
      // Repositories enabled by an older version get the hook events added since.
      try {
        if (installHookSettings(tracker.root).changed) output.appendLine(`Updated the Claude Code hook settings in ${tracker.root}`);
      } catch (e) {
        output.appendLine(`Could not update hook settings in ${tracker.root}: ${e}`);
      }
      this.add(tracker, folder.uri.fsPath);
    }
  }

  add(tracker: Tracker, folderPath: string): RepoView {
    const view = new RepoView(tracker, workspaceSpelling(tracker.root, folderPath), this.content, () => this.foldersChanged());
    this.views.set(tracker.root, view);
    void view.refresh();
    return view;
  }

  async pickView(arg?: unknown): Promise<RepoView | undefined> {
    if (arg instanceof RepoView) return arg;
    const rootUri = (arg as vscode.SourceControl | undefined)?.rootUri;
    if (rootUri) {
      for (const v of this.views.values()) if (v.scm.rootUri?.fsPath === rootUri.fsPath) return v;
    }
    const views = [...this.views.values()];
    if (views.length <= 1) return views[0];
    const pick = await vscode.window.showQuickPick(
      views.map((v) => ({ label: path.basename(v.tracker.root), description: v.tracker.root, view: v })),
      { placeHolder: 'Repository' },
    );
    return pick?.view;
  }

  findStagedGroup(group: vscode.SourceControlResourceGroup): RepoView | undefined {
    for (const view of this.views.values()) if (view.stagedGroup === group) return view;
    return undefined;
  }

  findChangesGroup(group: vscode.SourceControlResourceGroup): RepoView | undefined {
    for (const view of this.views.values()) if (view.changesGroup === group) return view;
    return undefined;
  }

  dispose(): void {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
  }
}

/**
 * Git reports the repository root by its long, canonical path; VS Code knows the folder by
 * whatever path it was opened with (short 8.3 names, drive-letter case). Resources must use
 * VS Code's spelling or the view shows absolute paths.
 */
function workspaceSpelling(repoRoot: string, folderPath: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(folderPath);
  } catch {
    return repoRoot;
  }
  const up = path.relative(real, repoRoot);
  if (up.split(path.sep).some((part) => part !== '..' && part !== '')) return repoRoot;
  return path.resolve(folderPath, up);
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Agent Changes');
  const iconTheme = new AgentIconTheme(context, (line) => output.appendLine(line));
  const manager = new Manager((folders) => iconTheme.setFolders(folders));
  const decorations = new AgentDecorations();
  const hookSource = context.asAbsolutePath(path.join('hook', 'agent-changes-hook.js'));
  context.subscriptions.push(
    output,
    manager,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, manager.content),
    vscode.window.registerFileDecorationProvider(decorations),
    iconTheme,
  );
  void iconTheme.apply().catch((e) => output.appendLine(`icon theme: ${e}`));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentChanges.agentFolderIcons') || e.affectsConfiguration('workbench.iconTheme')) {
        void iconTheme.apply().catch((err) => output.appendLine(`icon theme: ${err}`));
      }
    }),
  );

  // Keep an already-installed hook script in step with this version of the extension.
  try {
    if (fs.existsSync(hookDestination())) syncHookScript(hookSource);
  } catch (e) {
    output.appendLine(`could not update hook script: ${e}`);
  }

  const command = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (e) {
          output.appendLine(`[${new Date().toISOString()}] ${id}: ${(e as Error).stack ?? e}`);
          void vscode.window.showErrorMessage(`Agent Changes: ${(e as Error).message ?? e}`);
        }
      }),
    );

  const rowsOf = (args: unknown[]): AgentResource[] =>
    args.flat().filter((r): r is AgentResource => !!r && typeof r === 'object' && 'view' in r && 'path' in r);

  /** Groups the selected rows (or the rows under a selected folder) by repository and owner. */
  const selection = (args: unknown[]) => {
    const groups = new Map<string, { view: RepoView; owner: string; paths: string[] }>();
    for (const r of rowsOf(args).filter((r) => !r.staged)) {
      const key = `${r.view.tracker.root}\n${r.owner}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { view: r.view, owner: r.owner, paths: [] }));
      if (!g.paths.includes(r.path)) g.paths.push(r.path);
    }
    return [...groups.values()];
  };

  const stage = async (view: RepoView, owner: string, paths: string[], on: boolean) => {
    try {
      await view.tracker.setStaged(paths, owner, on);
    } catch (e) {
      if (!(e instanceof StagedConflict)) throw e;
      const choice = await vscode.window.showWarningMessage(
        `These files already have staged changes that weren't staged from Agent Changes:\n\n${e.paths.join('\n')}\n\nReplace what is staged for them?`,
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') return;
      await view.tracker.setStaged(paths, owner, on, true);
    }
    await view.refresh();
  };

  const discard = async (view: RepoView, owner: string, paths: string[]) => {
    const who = view.ownerLabel(owner);
    const choice = await vscode.window.showWarningMessage(
      `Discard the changes made by ${who} in ${paths.length === 1 ? paths[0] : `${paths.length} files`}?`,
      { modal: true, detail: "Other agents' changes in these files are kept. This can't be undone." },
      'Discard',
    );
    if (choice !== 'Discard') return;
    await view.tracker.discard(paths, owner);
    await view.refresh();
  };

  command('agentChanges.openDiff', async (res: AgentResource) => {
    if (!res?.view) return;
    const left = manager.content.uri(res.view, res.path, null);
    if (res.staged) {
      const right = manager.content.uri(res.view, res.path, INDEX);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(res.path)} (Staged)`, { preview: true });
      return;
    }
    const right = manager.content.uri(res.view, res.path, res.owner);
    const name = res.view.snapshot?.owners.find((o) => o.id === res.owner)?.name ?? res.owner;
    const title = `${path.basename(res.path)} · ${name}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  });

  command('agentChanges.openFile', async (res: AgentResource) => {
    if (res?.view) await vscode.window.showTextDocument(vscode.Uri.file(path.join(res.view.root, res.path)), { preview: false });
  });

  command('agentChanges.stageFile', async (...args: unknown[]) => {
    for (const s of selection(args)) await stage(s.view, s.owner, s.paths, true);
  });
  command('agentChanges.unstage', async (...args: unknown[]) => {
    const rows = rowsOf(args).filter((r) => r.staged);
    for (const view of new Set(rows.map((r) => r.view))) {
      await view.tracker.unstagePaths(rows.filter((r) => r.view === view).map((r) => r.path));
      await view.refresh();
    }
  });
  command('agentChanges.revertFile', async (...args: unknown[]) => {
    for (const s of selection(args)) await discard(s.view, s.owner, s.paths);
  });
  command('agentChanges.stageAll', async (group: vscode.SourceControlResourceGroup) => {
    const view = group && manager.findChangesGroup(group);
    if (!view?.snapshot) return;
    for (const o of view.snapshot.owners) {
      const paths = view.filesOf(o.id);
      if (paths.length) await stage(view, o.id, paths, true);
    }
  });
  command('agentChanges.discardAll', async (group: vscode.SourceControlResourceGroup) => {
    const view = group && manager.findChangesGroup(group);
    const files = [...(view?.snapshot?.files.values() ?? [])].filter((f) => f.unstaged.length);
    if (!view?.snapshot || !files.length) return;
    const staged = new Map(view.snapshot.staged.map((s) => [s.path, s]));
    const deleted = files.filter((f) => (staged.has(f.path) ? staged.get(f.path)!.index : f.base) === null).length;
    const choice = await vscode.window.showWarningMessage(
      `Discard all changes in ${files.length === 1 ? files[0].path : `${files.length} files`}?`,
      {
        modal: true,
        detail: [
          "Every agent's changes listed under Changes are discarded.",
          deleted ? `${deleted === 1 ? '1 file they created is' : `${deleted} files they created are`} deleted.` : '',
          "Staged changes are kept. This can't be undone.",
        ].filter(Boolean).join(' '),
      },
      'Discard All',
    );
    if (choice !== 'Discard All') return;
    await view.tracker.discardUnstaged(files.map((f) => f.path));
    await view.refresh();
  });
  command('agentChanges.unstageAll', async (group: vscode.SourceControlResourceGroup) => {
    const view = group && manager.findStagedGroup(group);
    if (!view?.snapshot?.staged.length) return;
    await view.tracker.unstagePaths(view.snapshot.staged.map((s) => s.path));
    await view.refresh();
  });

  command('agentChanges.commit', async (arg?: unknown) => {
    const view = await manager.pickView(arg);
    if (!view) return;
    let message = view.scm.inputBox.value.trim();
    if (!message) {
      message = (await vscode.window.showInputBox({ prompt: 'Commit message', ignoreFocusOut: true }))?.trim() ?? '';
      if (!message) return;
    }
    await view.tracker.commit(message);
    view.scm.inputBox.value = '';
    await view.refresh();
  });

  // Agents are folders in each row's path, so they only appear as dropdowns in tree view.
  // The view mode belongs to the whole Source Control panel; VS Code's own command switches it.
  const showAsTree = () => vscode.commands.executeCommand('workbench.scm.action.setTreeViewMode');
  command('agentChanges.showAsTree', showAsTree);

  command('agentChanges.refresh', async () => {
    await manager.scan();
    await Promise.all([...manager.views.values()].map((v) => v.refresh()));
  });

  command('agentChanges.reset', async (arg?: unknown) => {
    const view = await manager.pickView(arg);
    if (!view) return;
    const choice = await vscode.window.showWarningMessage(
      'Forget who changed what in this repository?',
      { modal: true, detail: 'Your files are not touched. All current changes will show as unattributed.' },
      'Reset',
    );
    if (choice !== 'Reset') return;
    await view.tracker.reset();
    await view.refresh();
  });

  command('agentChanges.enable', async () => {
    const trackers: Array<Tracker & { folder?: string }> = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const t = await Tracker.open(folder.uri.fsPath);
      if (t && !trackers.some((x) => x.root === t.root)) trackers.push(Object.assign(t, { folder: folder.uri.fsPath }));
    }
    if (!trackers.length) {
      void vscode.window.showWarningMessage('Agent Changes: open a folder that is inside a git repository first.');
      return;
    }
    let tracker = trackers[0];
    if (trackers.length > 1) {
      const pick = await vscode.window.showQuickPick(
        trackers.map((t) => ({ label: path.basename(t.root), description: t.root, t })),
        { placeHolder: 'Enable Agent Changes for which repository?' },
      );
      if (!pick) return;
      tracker = pick.t;
    }
    tracker.enable();
    syncHookScript(hookSource);
    const { file: settingsFile } = installHookSettings(tracker.root);
    if (!manager.views.has(tracker.root)) manager.add(tracker, tracker.folder ?? tracker.root);
    void vscode.window.showInformationMessage(
      `Agent Changes is on for ${path.basename(tracker.root)}. The Claude Code hook is in ${path.relative(tracker.root, settingsFile)}; restart Claude Code sessions in this repository so they pick it up.`,
    );
  });

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void manager.scan()));
  await manager.scan();

  // Switch to tree view once, so agents show as dropdowns without hunting for the menu. VS Code
  // ignores the command while the Source Control panel is closed, so wait until it draws a row.
  if (!context.globalState.get('agentChanges.treeViewOnce')) {
    decorations.onFirstRow.push(() =>
      setTimeout(async () => {
        try {
          await showAsTree();
          await context.globalState.update('agentChanges.treeViewOnce', true);
        } catch (e) {
          output.appendLine(`could not switch Source Control to tree view: ${e}`);
        }
      }, 300),
    );
  }
  // Offer the agent dots once agents are on screen, where the folder icons they replace show.
  decorations.onFirstRow.push(() => setTimeout(() => void iconTheme.offer().catch((e) => output.appendLine(`icon theme: ${e}`)), 1500));
  return { manager };
}

export function deactivate() {}
