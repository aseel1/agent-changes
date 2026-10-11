// Agent folders get the agent's colored dot instead of a folder icon.
//
// VS Code picks a folder's icon from the active file icon theme, by the folder's exact name,
// and gives extensions no other say over Source Control rows. So Agent Changes ships an icon
// theme of its own: a copy of the theme you use (vscode-icons, Seti, …) plus one rule per agent
// folder. Agent folder names start with an invisible character, so the rules never match a real
// folder. The theme is registered with `_watch` (as vscode-icons does), so VS Code reloads it
// when Agent Changes rewrites it for new agents.
//
// Switching someone's icon theme is their call, so nothing changes until they answer the
// one-time offer (or set agentChanges.agentFolderIcons themselves).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const ICON_THEME_ID = 'agent-changes-icons';
/** Marks agent folder names; zero-width, so it doesn't show. */
export const AGENT_FOLDER_MARK = '\u200b';
/** Remembered so the uninstall script can put the user's own icon theme back. */
export const BASE_THEME_FILE = path.join(os.homedir(), '.claude', 'agent-changes', 'base-icon-theme');
/** Set once the user answered the offer to show agent dots. */
const OFFERED = 'agentChanges.offeredFolderIcons';

/** Dot colors, in palette order, then unattributed and mixed. Dark and light variants. */
const DOTS: Array<[string, string]> = [
  ['#4FA3F7', '#1F6FD1'],
  ['#7DC35B', '#3C8A1E'],
  ['#B392F0', '#7B4FC9'],
  ['#F5A043', '#C26100'],
  ['#E8C547', '#9A7B00'],
  ['#F0646E', '#C62C3A'],
  ['#C98E6B', '#8A5232'],
];
const UNATTRIBUTED_DOT: [string, string] = ['#A0A0A0', '#6E6E6E'];

/** Palette index for a dot; -1 = unattributed, -2 = several agents (hollow dot). */
export type DotColor = number;

export class AgentIconTheme {
  private readonly file: string;
  private folders = new Map<string, DotColor>();
  private written = '';
  private baseWatcher: fs.FSWatcher | undefined;
  private watchedBase = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
  ) {
    this.file = context.asAbsolutePath(path.join('themes', 'agent-changes-icon-theme.json'));
  }

  /** What the user chose in agentChanges.agentFolderIcons; undefined until they choose. */
  private get choice(): boolean | undefined {
    const setting = vscode.workspace.getConfiguration('agentChanges').inspect<boolean>('agentFolderIcons');
    return setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
  }

  /** Whether the dotted theme is wanted: chosen, or (from before the offer existed) already on. */
  private get enabled(): boolean {
    return this.choice ?? vscode.workspace.getConfiguration('workbench').get('iconTheme') === ICON_THEME_ID;
  }

  /** Puts the right icon theme in place. Called on activation and when either setting changes. */
  async apply(): Promise<void> {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const current = workbench.get<string | null>('iconTheme');
    if (!this.enabled) {
      if (current === ICON_THEME_ID) await workbench.update('iconTheme', this.base(), vscode.ConfigurationTarget.Global);
      return;
    }
    if (this.choice === undefined) {
      this.write(true); // already on from an earlier version: keep it current, switch nothing
      return;
    }
    if (current === null) return; // file icons are switched off; nothing to put dots into
    if (current !== ICON_THEME_ID) {
      // Whatever theme the user picks becomes the one we copy.
      await this.context.globalState.update('agentChanges.baseIconTheme', current ?? 'vs-seti');
      try {
        fs.mkdirSync(path.dirname(BASE_THEME_FILE), { recursive: true });
        fs.writeFileSync(BASE_THEME_FILE, current ?? 'vs-seti');
      } catch {}
    }
    this.write(true);
    if (current !== ICON_THEME_ID) await workbench.update('iconTheme', ICON_THEME_ID, vscode.ConfigurationTarget.Global);
  }

  /**
   * Asks, once, whether to show agent dots. Answering sets agentChanges.agentFolderIcons, which
   * makes apply() switch (or not). Closing the message without answering asks again next time.
   */
  async offer(): Promise<void> {
    if (this.choice !== undefined || this.context.globalState.get(OFFERED)) return;
    const current = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
    if (current === null || current === ICON_THEME_ID) return;
    const yes = 'Show Dots';
    const answer = await vscode.window.showInformationMessage(
      `Agent Changes: show each agent's colored dot in Source Control instead of a folder icon? ` +
        `VS Code takes folder icons from the file icon theme, so this switches to a copy of ` +
        `${themeLabel(current ?? 'vs-seti')} with the dots added. Everything else looks the same.`,
      yes,
      'Keep Folder Icons',
    );
    if (!answer) return;
    await this.context.globalState.update(OFFERED, true);
    await vscode.workspace.getConfiguration('agentChanges').update('agentFolderIcons', answer === yes, vscode.ConfigurationTarget.Global);
  }

  /** The agent folder names on screen, with their dot colors. */
  setFolders(folders: Map<string, DotColor>): void {
    if (folders.size === this.folders.size && [...folders].every(([k, v]) => this.folders.get(k) === v)) return;
    this.folders = new Map(folders);
    if (this.enabled) this.write(false);
  }

  dispose(): void {
    this.baseWatcher?.close();
  }

  private base(): string {
    const remembered = this.context.globalState.get<string>('agentChanges.baseIconTheme');
    if (remembered) return remembered;
    try {
      return fs.readFileSync(BASE_THEME_FILE, 'utf8').trim() || 'vs-seti'; // shared across installs
    } catch {
      return 'vs-seti';
    }
  }

  private write(force: boolean): void {
    const baseFile = findIconThemeFile(this.base());
    if (!baseFile) {
      this.log(`icon theme "${this.base()}" not found; agent folders keep their folder icons`);
      return;
    }
    this.watchBase(baseFile);
    let theme: any;
    try {
      theme = parseJsonc(fs.readFileSync(baseFile, 'utf8'));
    } catch (e) {
      this.log(`could not read icon theme ${baseFile}: ${e}`);
      return;
    }
    const themeDir = path.dirname(this.file);
    const from = (p: string) => path.relative(themeDir, path.resolve(path.dirname(baseFile), p)).split(path.sep).join('/');
    for (const def of Object.values<any>(theme.iconDefinitions ?? {})) if (def.iconPath) def.iconPath = from(def.iconPath);
    for (const font of theme.fonts ?? []) for (const src of font.src ?? []) if (src.path) src.path = from(src.path);

    theme.iconDefinitions ??= {};
    const dotId = (c: DotColor, light: boolean) => `_agent_changes_dot_${c < 0 ? (c === -1 ? 'u' : 'm') : c}${light ? '_light' : ''}`;
    for (const c of [...DOTS.keys(), -1, -2]) {
      for (const light of [false, true]) {
        const id = dotId(c, light);
        theme.iconDefinitions[id] = { iconPath: `dots/${id}.svg` };
        writeDot(path.join(themeDir, 'dots', `${id}.svg`), c, light);
      }
    }
    for (const [name, color] of this.folders) {
      const key = name.toLowerCase();
      for (const section of [theme, theme.light].filter(Boolean)) {
        const light = section === theme.light;
        (section.folderNames ??= {})[key] = dotId(color, light);
        (section.folderNamesExpanded ??= {})[key] = dotId(color, light);
      }
    }

    const text = JSON.stringify(theme);
    if (!force && text === this.written) return;
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(this.file, text);
    this.written = text;
  }

  /** The base theme can change under us (vscode-icons regenerates its theme on setting changes). */
  private watchBase(baseFile: string): void {
    if (this.watchedBase === baseFile) return;
    this.baseWatcher?.close();
    this.watchedBase = baseFile;
    let timer: NodeJS.Timeout | undefined;
    try {
      this.baseWatcher = fs.watch(baseFile, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.enabled && this.write(false), 500);
      });
    } catch {}
  }
}

function findIconThemeFile(id: string): string | undefined {
  for (const ext of vscode.extensions.all) {
    for (const theme of ext.packageJSON?.contributes?.iconThemes ?? []) {
      if (theme.id === id && theme.path) return path.join(ext.extensionPath, theme.path);
    }
  }
  return undefined;
}

/** The theme's name as the icon theme picker shows it. */
function themeLabel(id: string): string {
  for (const ext of vscode.extensions.all) {
    for (const theme of ext.packageJSON?.contributes?.iconThemes ?? []) {
      if (theme.id === id && typeof theme.label === 'string' && !theme.label.startsWith('%')) return `"${theme.label}"`;
    }
  }
  return 'your icon theme';
}

function writeDot(file: string, color: DotColor, light: boolean): void {
  if (fs.existsSync(file)) return;
  const [dark, lite] = color === -1 || color === -2 ? UNATTRIBUTED_DOT : DOTS[color];
  const fill = light ? lite : dark;
  const shape =
    color === -2
      ? `<circle cx="8" cy="8" r="3.75" fill="none" stroke="${fill}" stroke-width="1.5"/>`
      : `<circle cx="8" cy="8" r="4.5" fill="${fill}"/>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${shape}</svg>`);
}

/** JSON with comments and trailing commas, as theme files may be. */
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  }
}
