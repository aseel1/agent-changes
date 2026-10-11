# Agent Changes

When several Claude Code agents work in the same repository at once (a main session, its subagents, or several sessions), the Git view mixes all their edits together. **Agent Changes** adds a second Source Control view laid out like the Git view, with every change filed under the agent that made it. Switch Source Control to tree view (`…` → **View as Tree**) to get each agent as its own dropdown:

```
AGENT CHANGES
  ˅ Staged Changes                          1
      smoke.txt                             A
  ˅ Changes                                 4
    ˅ 🔵 Refactor the payment flow
        calc.js                             M
        api.ts                              M
    ˅ 🟢 Add multiply (general-purpose)
        calc.js                             M
    ˅ ⚪ Unattributed (you or other tools)
        notes.md                            M
```

In list view, the agent shows next to each file, where the Git view shows the folder.

In tree view, each agent row shows the agent's colored dot instead of a folder icon. VS Code takes folder icons from the file icon theme, so Agent Changes switches your icon theme to **Your Icon Theme + Agent Changes Dots**: an exact copy of the theme you use (vscode-icons, Seti, …) plus a rule per agent folder, kept up to date as agents come and go. Everything else, the Explorer included, looks the same. Turn it off with the `agentChanges.agentFolderIcons` setting; uninstalling Agent Changes puts your own theme back.

Same branch, same files on disk; nothing is copied or moved. A file that several agents edited appears under each of them, and each one shows only that agent's lines.

## What you can do

| Where | Action |
|---|---|
| Click a file under Changes | Diff of the committed file against **only this agent's changes** |
| File row | Open file · Discard this agent's changes · Stage this agent's changes |
| Agent dropdown (tree view) | Stage or discard **everything** that agent did |
| Changes header | Discard all changes (every agent at once; staged changes are kept, as in Git) · Stage all changes |
| Staged Changes | Everything in the index, all together like the Git view (hover a file to see which agent it came from). Click a file to see exactly what will be committed; unstage per file or all at once |
| Message box + ✓ | Commit what you staged (one commit per agent, or stage several and commit once) |
| `…` menu | Reset tracking (forget who changed what) |

Staging writes exactly "the committed file + this agent's lines" into the index, so you can commit agent by agent. Discarding rewrites the file on disk with that agent's lines removed and everyone else's kept.

## Setup

1. Install the extension (`code --install-extension agent-changes-0.1.0.vsix`).
2. Open the repository and run **Agent Changes: Enable for This Repository** from the Command Palette. This:
   - creates `.git/agent-changes/` (all tracking data lives there, never committed),
   - copies the hook script to `~/.claude/agent-changes/agent-changes-hook.js`,
   - registers it in `<repo>/.claude/settings.local.json` (your existing settings are kept).
3. Restart any Claude Code sessions running in that repository so they load the hook.

The hook only records in repositories where `.git/agent-changes/` exists, so registering it in your user-level `~/.claude/settings.json` instead is safe too.

## How it works

A Claude Code hook runs before and after every `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Bash` call. It snapshots the affected files and appends an event to `.git/agent-changes/log.jsonl`, tagged with the session id and, for subagents, the `agent_id` and `agent_type` that Claude Code passes to hooks. For `Bash`, it compares `git status` before and after the command. When the `Agent` tool finishes, its description becomes the group's name.

A main agent's group is named after its Claude Code session, and follows it when you rename the session (within a couple of seconds, no new prompt needed):

1. a name you gave it (`claude -n`, `/rename`);
2. otherwise the title Claude Code generates;
3. until then, the first line of your first prompt, without blocks that tools inject (such as `<browser_instruction>`).

Renames and generated titles are written to the session transcript without any hook firing, so the hook records where each session's transcript is and the extension follows those files, reading only what was appended. The transcript format is internal to Claude Code: the name entry (`custom-title`) is verified on Claude Code 2.1.292, the generated-title entry is matched loosely, and anything unrecognised falls back to the next option.

The extension replays that log into a line-level ownership model of each changed file:

- Every changed line remembers who added it and who removed it, so each agent's version of a file can be rebuilt from the committed text plus only its lines.
- An agent that started from an older copy of a file (parallel agents do) is credited only with what it actually changed.
- Anything no event explains, such as your own edits or a formatter run outside Claude, goes to **Unattributed**.
- When one agent edits lines another agent wrote, the later agent's view includes the earlier edit it built on (so each view is still a coherent file), and the earlier agent's view shows its own version of those lines. Both groups list the file, and the tooltip says who else changed it.
- After a commit, the committed changes become the new baseline and the rest keep their owners.

## Limits of this first version

- Two agents running **shell commands at the same moment** can't be told apart; files those commands change show as Unattributed.
- Changes made by **background processes** an agent started (a dev server, a watcher) show as Unattributed.
- Binary files and files over 8 MB are attributed whole-file to their last writer.
- If you stage the same files from the regular Git view as well, Agent Changes asks before replacing what's staged.
- Agents still share one working tree: an agent running a build or tests sees other agents' half-finished edits. Use worktrees when that matters.

## Development

```
npm install
npm test          # unit tests + end-to-end tests that drive the real hook against a temp repo
npm run package   # builds agent-changes-0.1.0.vsix
```
