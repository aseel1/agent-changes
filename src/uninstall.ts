// Runs when the extension is uninstalled (package.json "vscode:uninstall"). If the user's icon
// theme is still Agent Changes' copy, put their own theme back. No VS Code API is available here.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const THEME_ID = 'agent-changes-icons';
const baseFile = path.join(os.homedir(), '.claude', 'agent-changes', 'base-icon-theme');

function settingsFiles(): string[] {
  const products = ['Code', 'Code - Insiders', 'VSCodium'];
  const roots =
    process.platform === 'win32'
      ? [process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')]
      : process.platform === 'darwin'
        ? [path.join(os.homedir(), 'Library', 'Application Support')]
        : [process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')];
  return roots.flatMap((root) => products.map((p) => path.join(root, p, 'User', 'settings.json')));
}

let base = 'vs-seti';
try {
  base = fs.readFileSync(baseFile, 'utf8').trim() || base;
} catch {}

for (const file of settingsFiles()) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(new RegExp(`("workbench\\.iconTheme"\\s*:\\s*)"${THEME_ID}"`), `$1${JSON.stringify(base)}`);
    if (next !== text) fs.writeFileSync(file, next);
  } catch {}
}
