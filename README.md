<p align="center">
  <img src="media/icon.png" alt="Agent Changes logo" width="96">
</p>

<h1 align="center">Agent Changes</h1>

<p align="center">
  <b>See what each Claude Code agent changed, on its own, right in VS Code's Source Control.</b><br>
  One branch, one working tree, and every agent's work kept apart.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=aseel1.agent-changes"><img alt="VS Code Marketplace" src="https://img.shields.io/badge/VS_Code_Marketplace-install-007ACC"></a>
  <img alt="Preview" src="https://img.shields.io/badge/status-preview-E8C547">
  <img alt="VS Code 1.90+" src="https://img.shields.io/badge/VS_Code-1.90%2B-007ACC">
  <img alt="For Claude Code" src="https://img.shields.io/badge/for-Claude_Code-D97757">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3DA639">
  <img alt="Local only, no telemetry" src="https://img.shields.io/badge/telemetry-none-555">
</p>

<p align="center">
  <img src="media/overview.png" alt="Source Control with one dropdown per agent. Clicking app.js under 'Add dark mode' shows only that agent's change." width="900">
</p>

---

## Why

Run a few Claude Code agents at once (a main session, its subagents, a second session in another terminal) and they all edit the same files on the same branch. Git's **Changes** list mixes everything together: you can't tell which agent did what, review one agent's work, or commit it on its own.

**Agent Changes** adds a Source Control view that files every change under the agent that made it. Nothing is copied or moved: same branch, same files on disk, no worktrees.

## Features

- 🗂️ **One dropdown per agent.** Main sessions are named after their Claude Code session and follow `/rename` live. Subagents are named after their task. Each agent gets its own color.
- 🔍 **Only that agent's lines.** Click a file to diff the committed version against just that agent's edits, even when several agents changed the same file.
- ✅ **Stage, commit and discard per agent.** Commit agent by agent, or throw away one agent's work and keep everyone else's.
- 🧹 **Discard All, Git-style.** Clears everything under Changes in one click; what you staged stays.
- 🙋 **Unattributed group.** Your own edits and tools outside Claude land in their own group, so nothing is hidden.
- 🔒 **Local only.** No network, no telemetry. Tracking data lives in `.git/agent-changes/` and is never committed.

<table>
  <tr>
    <th>The same <code>app.js</code>, under <i>Add dark mode</i></th>
    <th>…and under <i>Fix date formatting</i></th>
  </tr>
  <tr>
    <td><img src="media/diff-dark-mode.png" alt="app.js diff showing only the dark mode toggle"></td>
    <td><img src="media/diff-dates.png" alt="app.js diff showing only the sorting change"></td>
  </tr>
</table>

## Requirements

| | |
|---|---|
| **VS Code** | 1.90 or later |
| **Claude Code** | the CLI or the VS Code extension (tested with 2.1.x) |
| **Git** | the project must be a Git repository |
| **Node.js** | 18 or later, available as `node` on your PATH (the Claude Code hook runs with it) |

## Installation

### Option 1: VS Code Marketplace (recommended)

Open Extensions (`Ctrl+Shift+X`, or `Cmd+Shift+X` on macOS), search for **Agent Changes**, and click **Install**. Or install it from the [**Marketplace page**](https://marketplace.visualstudio.com/items?itemName=aseel1.agent-changes), or from a terminal:

```bash
code --install-extension aseel1.agent-changes
```

VS Code keeps it up to date from then on.

### Option 2: download the `.vsix`

For editors that don't use the VS Code Marketplace, or machines without internet access.

1. Open the [**latest release**](https://github.com/aseel1/agent-changes/releases/latest) and download `agent-changes-<version>.vsix` under **Assets**.
2. In Extensions, click **`…`** at the top of the panel, choose **Install from VSIX…**, and pick the downloaded file. Or from a terminal:
   ```bash
   code --install-extension agent-changes-<version>.vsix
   ```

### Option 3: build from source

```bash
git clone https://github.com/aseel1/agent-changes.git
cd agent-changes
npm install
npm run package                      # creates agent-changes-<version>.vsix
code --install-extension agent-changes-<version>.vsix
```

## Quick start

1. **Open your project** (a Git repository) in VS Code.
2. **Turn it on for the repository:** open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Agent Changes: Enable for This Repository**.
3. **Restart Claude Code sessions** already running in that repository so they load the hook. New sessions pick it up automatically.
4. **Open Source Control** (`Ctrl+Shift+G`) and use Claude as usual. Each agent's changes appear under **Agent Changes** as they happen. The first time, you'll be asked whether to show [colored dots](#the-colored-dots) for agents.

> [!TIP]
> Agents appear as dropdowns when Source Control is in **tree view**. Agent Changes switches to it the first time it runs. If you see a flat list, click the tree button in the Agent Changes title bar.

<details>
<summary><b>What does "Enable for This Repository" change?</b></summary>
<br>

- Creates `.git/agent-changes/`, where all tracking data lives. It sits inside `.git`, so it is never committed.
- Copies the hook script to `~/.claude/agent-changes/agent-changes-hook.js`.
- Adds the hook to `<repo>/.claude/settings.local.json`, Claude Code's personal settings file for the project. Your existing settings are kept.

The hook records nothing in repositories where `.git/agent-changes/` doesn't exist, so you can also register it once in `~/.claude/settings.json` to cover Claude sessions started from any folder.
</details>

## Using it

<p align="center">
  <img src="media/agents.png" alt="Hovering an agent shows Discard and Stage buttons" width="440"><br>
  <sub>Hover an agent (or a file) for its Discard and Stage buttons.</sub>
</p>

| Where | What you can do |
|---|---|
| **Click a file** under an agent | Diff of the committed file against **only that agent's changes** |
| **File row** buttons | Open file · Discard · Stage, for that agent's changes only |
| **Agent row** buttons | Discard or stage **everything** that agent did |
| **Changes** header | Discard all · Stage all |
| **Staged Changes** | Everything staged, together like the Git view. Click a file to see exactly what will be committed; hover it to see which agent it came from |
| **Message box** + ✓ (or `Ctrl+Enter`) | Commit what you staged |
| **`…`** menu | Reset tracking (forget who changed what; your files are untouched) |

Staging writes exactly *the committed file plus this agent's lines* into the Git index, so each commit can hold one agent's work. Discarding rewrites the file with that agent's lines removed and everyone else's kept. **Discard All** works like Git's: every file under Changes goes back to its staged version (or the last commit), and staged work is kept.

The Git view keeps working next to it. Staging in either one shows up in both.

### How agents are named

| Agent | Name shown |
|---|---|
| Main session | Its Claude Code session name (`claude -n "…"` or `/rename`, which updates live), otherwise the title Claude Code generates, otherwise your first prompt |
| Subagent | The task description it was launched with, plus its type, e.g. *Write tests for the theme toggle (general-purpose)* |
| Unattributed | Changes no agent made: your own edits, formatters, other tools |

### The colored dots

VS Code takes folder icons from your file icon theme, so drawing a colored dot instead of a folder icon for each agent means changing the icon theme. Agent Changes **asks once**, the first time agents appear in Source Control:

- **Show Dots** switches to **Your Icon Theme + Agent Changes Dots**: an exact copy of the theme you already use (Seti, vscode-icons, …) with the dots added. Everything else, the Explorer included, looks the same.
- **Keep Folder Icons** leaves your theme alone. Agents then show with a regular folder icon.

You can change your mind any time with the `agentChanges.agentFolderIcons` setting. Turning it off, or uninstalling the extension, puts your own theme back.

## Settings

| Setting | Default | Description |
|---|---|---|
| `agentChanges.agentFolderIcons` | `false`, until you answer the one-time question | Show each agent's colored dot instead of a folder icon (uses a copy of your icon theme, see [The colored dots](#the-colored-dots)). |

## Privacy

- Everything stays on your machine. The extension makes **no network requests** and collects **no telemetry**.
- The hook stores copies of the files agents change in `.git/agent-changes/`. Delete that folder, or run **Reset Tracking**, at any time.
- To follow session renames, the extension reads the title entries that Claude Code appends to the session's transcript file. It reads nothing else from transcripts.

## Troubleshooting

<details>
<summary><b>Nothing shows up under Agent Changes</b></summary>
<br>

1. Make sure you ran **Agent Changes: Enable for This Repository** in this repository.
2. Restart the Claude Code session. Sessions only load hooks when they start.
3. Check that `node --version` works in a terminal. The hook runs with Node.js.
4. Was the session started from a different folder? Hooks are registered per repository. Start Claude inside the repository, or register the hook in `~/.claude/settings.json` (see *What does "Enable" change?*).
</details>

<details>
<summary><b>I see a flat list instead of one dropdown per agent</b></summary>
<br>

Switch Source Control to tree view: click the tree button in the Agent Changes title bar, or `…` → **View & Sort** → **View as Tree**.
</details>

<details>
<summary><b>An agent's change shows up as Unattributed</b></summary>
<br>

Agent Changes can only credit what the hook saw. Changes made by your own edits, by background processes an agent started (a dev server, a watcher), or by two agents' shell commands running at the exact same moment are shown as Unattributed.
</details>

<details>
<summary><b>My file icons look different</b></summary>
<br>

Set `agentChanges.agentFolderIcons` to `false`, or pick your usual theme in **Preferences: File Icon Theme**. See [The colored dots](#the-colored-dots).
</details>

## How it works

<details>
<summary>The details, for the curious</summary>
<br>

A [Claude Code hook](https://code.claude.com/docs/en/hooks) runs before and after every `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Bash` call. It snapshots the affected files and appends an event to `.git/agent-changes/log.jsonl`, tagged with the session id and, for subagents, the `agent_id` and `agent_type` Claude Code passes to hooks. For `Bash`, it compares `git status` before and after the command. When the `Agent` tool finishes, its description becomes the subagent's name.

The extension replays that log into a line-level ownership model of each changed file:

- Every changed line remembers who added it and who removed it, so each agent's version of a file can be rebuilt from the committed text plus only its lines.
- An agent that started from an older copy of a file (parallel agents do) is credited only with what it actually changed.
- When one agent edits lines another agent wrote, the later agent's view includes the edit it built on, so every view is still a coherent file. Both agents list the file, and the tooltip says who else changed it.
- After a commit, the committed changes become the new baseline and the rest keep their owners.

Session renames and generated titles are written to the session transcript without any hook firing, so the hook records where each transcript is, and the extension follows those files, reading only what was appended.
</details>

## Known limitations

- Two agents running **shell commands at the same moment** can't be told apart. Files those commands change show as Unattributed.
- Changes made by **background processes** an agent started show as Unattributed.
- **Binary files** and files over 8 MB are credited whole to their last writer.
- Agents still **share one working tree**: an agent running a build or tests sees the other agents' half-finished edits. Use worktrees when that matters.
- VS Code sorts the agent dropdowns **alphabetically**, not by when each agent started.
- This is a **preview**, tested mostly on **Windows**. macOS and Linux should work, and reports are welcome.

## Uninstall

1. Uninstall **Agent Changes** from the Extensions view. Your own icon theme is restored.
2. In each repository you enabled, remove the hook entries that mention `agent-changes-hook.js` from `.claude/settings.local.json`, and delete `.git/agent-changes/`.
3. Delete `~/.claude/agent-changes/`. Do this **after** step 2, or Claude Code will report a missing hook script.

## Development

```bash
npm install
npm test            # unit tests + end-to-end tests that drive the real hook against a temp repo
npm run package     # builds agent-changes-<version>.vsix
```

| Path | What's there |
|---|---|
| `hook/agent-changes-hook.js` | The Claude Code hook (plain Node.js, no dependencies) |
| `src/engine/` | Log replay, the line ownership model, Git plumbing, hook installation |
| `src/extension.ts` | The Source Control view, commands and decorations |
| `src/iconTheme.ts` | The icon theme copy that draws the agent dots |

Issues and pull requests are welcome.

## Disclaimer

Agent Changes is an independent project. It is not affiliated with or endorsed by Anthropic. *Claude* and *Claude Code* are trademarks of Anthropic.

## License

[MIT](LICENSE) © 2026 Aseel Shaheen
