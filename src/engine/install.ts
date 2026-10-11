// Registers the hook with Claude Code for one repository.
//
// The script is copied to a stable place (~/.claude/agent-changes/) so extension updates
// don't break the path, and registered in <repo>/.claude/settings.local.json, which Claude
// Code reads for that project and which is meant to stay out of git.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HOOK_FILE = 'agent-changes-hook.js';

const FILE_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
const HOOKS: Record<string, string | undefined> = {
  PreToolUse: `${FILE_TOOLS}|Bash`,
  PostToolUse: `${FILE_TOOLS}|Bash|Agent|Task`,
  PostToolUseFailure: `${FILE_TOOLS}|Bash`,
  UserPromptSubmit: undefined,
  SessionStart: undefined,
  Stop: undefined,
  SessionEnd: undefined,
};

export function hookDestination(home = os.homedir()): string {
  return path.join(home, '.claude', 'agent-changes', HOOK_FILE);
}

/** Copies the hook script into place. Returns true if the file changed. */
export function syncHookScript(source: string, dest = hookDestination()): boolean {
  const next = fs.readFileSync(source);
  try {
    if (fs.readFileSync(dest).equals(next)) return false;
  } catch {}
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
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
