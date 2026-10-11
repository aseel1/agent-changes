#!/usr/bin/env node
// Agent Changes: Claude Code hook that records which agent changed which file.
//
// Registered for PreToolUse / PostToolUse / PostToolUseFailure (file tools, Bash, Agent),
// and UserPromptSubmit / SessionStart / Stop / SessionEnd (session names). It only records
// in repositories where <git-dir>/agent-changes/ exists (created by "Agent Changes: Enable
// for This Repository"), and it never blocks or changes a tool call: it prints nothing and
// always exits 0.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_BLOB = 8 * 1024 * 1024;
const MAX_DIRTY = 5000;
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

let storeForErrors = null;

function main(input) {
  const event = input.hook_event_name;
  if (event === 'UserPromptSubmit' || event === 'SessionStart') return onSession(input);
  if (event === 'Stop' || event === 'SessionEnd') return onTurnEnd(input);
  // Claude Code passes the session's current name on some events; pick up renames early.
  if (typeof input.session_title === 'string' && input.session_title.trim()) onSession(input);

  const isPre = event === 'PreToolUse';
  const isPost = event === 'PostToolUse' || event === 'PostToolUseFailure';
  if (!isPre && !isPost) return;

  const tool = input.tool_name;
  if (FILE_TOOLS.has(tool)) return isPre ? preFile(input) : postFile(input);
  if (tool === 'Bash') return isPre ? preBash(input) : postBash(input);
  if (AGENT_TOOLS.has(tool) && isPost) return onAgent(input);
}

// ---------------------------------------------------------------- file tools

function fileTarget(input) {
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file) return null;
  const abs = path.resolve(input.cwd || process.cwd(), file);
  const repo = findRepo(path.dirname(abs));
  if (!repo) return null;
  const rel = relPath(repo.root, abs);
  if (!rel) return null;
  return { repo, abs, rel };
}

function preFile(input) {
  const target = fileTarget(input);
  if (!target) return;
  const { repo, abs, rel } = target;
  maybePrunePending(repo.store);
  writeJson(pendingPath(repo.store, input), {
    kind: 'file',
    t: Date.now(),
    ...who(input),
    rel,
    before: snapFile(repo.store, abs),
  });
}

function postFile(input) {
  const target = fileTarget(input);
  if (!target) return;
  const { repo, abs, rel } = target;
  const pp = pendingPath(repo.store, input);
  const pending = readJson(pp);
  removeFile(pp);

  const after = snapFile(repo.store, abs);
  if (after === undefined) return;
  if (pending && pending.before === after) return; // nothing changed (failed or no-op edit)

  const event = {
    v: 1,
    t: Date.now(),
    kind: 'file',
    tool: input.tool_name,
    ...who(input),
    file: rel,
    after,
    toolUseId: input.tool_use_id || null,
  };
  // Without a "before" snapshot the engine attributes the whole difference to this agent.
  if (pending && pending.before !== undefined) event.before = pending.before;
  appendEvents(repo.store, [event]);
}

// ---------------------------------------------------------------- Bash

function preBash(input) {
  const repo = findRepo(input.cwd || process.cwd());
  if (!repo) return;
  maybePrunePending(repo.store);
  const snap = dirtySnapshot(repo);
  if (!snap) return;
  writeJson(pendingPath(repo.store, input), {
    kind: 'bash',
    t: Date.now(),
    ...who(input),
    snap,
  });
}

function postBash(input) {
  const repo = findRepo(input.cwd || process.cwd());
  if (!repo) return;
  const pp = pendingPath(repo.store, input);
  const pending = readJson(pp);
  removeFile(pp);
  if (!pending || pending.kind !== 'bash') return;

  const now = dirtySnapshot(repo);
  if (!now) return;

  const me = ownerKey(who(input));
  const others = listPending(repo.store).filter((p) => p.file !== path.basename(pp));
  // A file another tool call is editing right now belongs to that call, not to this command.
  const busyFiles = new Set(others.filter((p) => p.data.kind === 'file').map((p) => p.data.rel));
  // Shell commands from different agents running at the same time can't be told apart.
  const ambiguous = new Set(
    others.filter((p) => p.data.kind === 'bash' && ownerKey(p.data) !== me).map((p) => ownerKey(p.data)),
  );
  for (const e of readRecentEvents(repo.store)) {
    if (e.kind === 'bash' && e.t >= pending.t && ownerKey(e) !== me) ambiguous.add(ownerKey(e));
  }

  const command = String((input.tool_input && input.tool_input.command) || '').slice(0, 300);
  const events = [];
  const paths = new Set([...Object.keys(pending.snap), ...Object.keys(now)]);
  for (const rel of paths) {
    if (busyFiles.has(rel)) continue;
    // Clean before the command: its content was the committed version (or it didn't exist).
    const before = rel in pending.snap ? pending.snap[rel] : headBlob(repo, rel);
    // Clean after the command: read what is on disk now.
    const after = rel in now ? now[rel] : snapFile(repo.store, path.join(repo.root, rel));
    if (after === undefined || before === after) continue;
    const event = {
      v: 1,
      t: Date.now(),
      kind: 'bash',
      tool: 'Bash',
      ...who(input),
      file: rel,
      before,
      after,
      command,
      toolUseId: input.tool_use_id || null,
    };
    if (ambiguous.size) event.ambiguous = [...ambiguous];
    events.push(event);
  }
  appendEvents(repo.store, events);
}

// Map of repo-relative path -> blob id (null = deleted) for every file git reports as changed.
function dirtySnapshot(repo) {
  let out;
  try {
    out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repo.root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const parts = out.toString('utf8').split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // Renames and copies are followed by the original path.
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++;
      if (parts[i]) paths.push(parts[i]);
    }
  }
  if (paths.length > MAX_DIRTY) return null;

  const cachePath = path.join(repo.store, 'statcache.json');
  const cache = readJson(cachePath) || {};
  const nextCache = {};
  const snap = {};
  for (const rel of paths) {
    if (rel.startsWith('.git/')) continue;
    const abs = path.join(repo.root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      snap[rel] = null;
      continue;
    }
    if (!st.isFile()) continue;
    const hit = cache[rel];
    if (hit && hit.m === st.mtimeMs && hit.s === st.size && blobExists(repo.store, hit.h)) {
      snap[rel] = hit.h;
      nextCache[rel] = hit;
      continue;
    }
    const id = snapFile(repo.store, abs);
    if (id === undefined) continue;
    snap[rel] = id;
    if (id !== null) nextCache[rel] = { m: st.mtimeMs, s: st.size, h: id };
  }
  writeJson(cachePath, nextCache);
  return snap;
}

function headBlob(repo, rel) {
  try {
    const buf = execFileSync('git', ['cat-file', 'blob', `HEAD:${rel}`], {
      cwd: repo.root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return putBlob(repo.store, buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- labels

function onAgent(input) {
  const res = input.tool_response;
  const agentId = res && typeof res === 'object' ? res.agentId || res.agent_id : null;
  if (!agentId) return;
  const repo = findRepo(input.cwd || process.cwd());
  if (!repo) return;
  const ti = input.tool_input || {};
  appendEvents(repo.store, [
    {
      v: 1,
      t: Date.now(),
      kind: 'agent',
      session: input.session_id,
      agent: String(agentId),
      agentType: res.agentType || ti.subagent_type || null,
      description: ti.description ? String(ti.description).slice(0, 120) : null,
      parent: input.agent_id || null,
    },
  ]);
}

// Records the session's name whenever Claude Code reports a new one (`claude -n`, /rename);
// until the session has a name, the first prompt's text stands in for it.
function onSession(input) {
  const repo = findRepo(input.cwd || process.cwd());
  if (!repo || !input.session_id) return;
  noteTranscript(repo, input);
  if (typeof input.session_title === 'string' && input.session_title.trim()) {
    return recordTitle(repo, input.session_id, input.session_title, 'name');
  }
  recordTitle(repo, input.session_id, promptTitle(input.prompt), 'prompt');
}

function onTurnEnd(input) {
  const repo = findRepo(input.cwd || process.cwd());
  if (repo && input.session_id) noteTranscript(repo, input);
}

// Tells the extension where the session's transcript is. Renames and the title Claude Code
// generates are written there without any hook firing, so the extension follows the file.
function noteTranscript(repo, input) {
  const file = input.transcript_path;
  if (!file) return;
  const marker = sessionMarker(repo, input.session_id);
  const known = readJson(marker) || {};
  if (known.transcript === file) return;
  writeJson(marker, { ...known, transcript: file });
  appendEvents(repo.store, [{ v: 1, t: Date.now(), kind: 'session', session: input.session_id, transcript: file }]);
}

function sessionMarker(repo, session) {
  return path.join(repo.store, 'sessions', safeName(session));
}

function recordTitle(repo, session, raw, source) {
  const title = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return;
  const marker = sessionMarker(repo, session);
  const known = readJson(marker) || {};
  if (source === 'prompt' ? known.title : known.source === 'name' && known.title === title) return;
  writeJson(marker, { ...known, title, source });
  appendEvents(repo.store, [{ v: 1, t: Date.now(), kind: 'session', session, title, source }]);
}

// First readable line of a prompt, without blocks that tools inject into it. Those use tag
// names like <browser_instruction>, <system-reminder> or <ide_selection>; ordinary markup
// such as <b>…</b> only loses its tags.
function promptTitle(prompt) {
  let text = String(prompt || '');
  const injected = /<([A-Za-z]+[_-][\w:-]*)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
  for (let i = 0; i < 5; i++) text = text.replace(injected, '\n');
  text = text.replace(/<([A-Za-z]+[_-][\w:-]*)(\s[^>]*)?>[\s\S]*$/, '\n'); // an injected block that never closes
  text = text.replace(/<\/?[A-Za-z][\w:-]*(\s[^>]*)?\/?>/g, '');
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s#>*-]+/, '').trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l));
  return line ? line.replace(/\s+/g, ' ').slice(0, 80) : '';
}

// ---------------------------------------------------------------- storage

function who(input) {
  return { session: input.session_id || 'unknown', agent: input.agent_id || null, agentType: input.agent_type || null };
}

function ownerKey(w) {
  return w.agent ? `${w.session}/${w.agent}` : w.session;
}

function findRepo(startDir) {
  let dir = startDir;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  let out;
  try {
    out = execFileSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const [top, gitDir] = out.split(/\r?\n/);
  if (!top || !gitDir) return null;
  const store = path.join(gitDir, 'agent-changes');
  if (!fs.existsSync(store)) return null; // tracking isn't enabled for this repository
  storeForErrors = store;
  return { root: realpath(top), store };
}

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Resolves short (8.3) names and symlinks even when the file itself doesn't exist yet.
function realpathLoose(p) {
  const rest = [];
  let cur = p;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(realpath(cur), ...rest);
}

function relPath(root, abs) {
  const rel = path.relative(root, realpathLoose(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) return null;
  return posix;
}

function blobPath(store, id) {
  return path.join(store, 'blobs', id.slice(0, 2), id.slice(2));
}

function blobExists(store, id) {
  return typeof id === 'string' && !id.startsWith('big:') && fs.existsSync(blobPath(store, id));
}

// Content-addressed copy of a file version. Files over MAX_BLOB keep only their hash.
function putBlob(store, buf) {
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  if (buf.length > MAX_BLOB) return `big:${sha}`;
  const p = blobPath(store, sha);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    try {
      fs.renameSync(tmp, p);
    } catch {
      removeFile(tmp);
    }
  }
  return sha;
}

// Blob id of a file, null if it doesn't exist, undefined if it isn't a regular file.
function snapFile(store, abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    if (e.code === 'EISDIR') return undefined;
    throw e;
  }
  return putBlob(store, buf);
}

function safeName(s) {
  return String(s).replace(/[^\w.-]/g, '_');
}

function pendingPath(store, input) {
  const id =
    input.tool_use_id ||
    crypto
      .createHash('sha1')
      .update(JSON.stringify([input.session_id, input.agent_id, input.tool_name, input.tool_input]))
      .digest('hex');
  return path.join(store, 'pending', `${safeName(id)}.json`);
}

function listPending(store) {
  const dir = path.join(store, 'pending');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const data = readJson(path.join(dir, file));
    if (data && Date.now() - data.t < PENDING_TTL_MS) out.push({ file, data });
  }
  return out;
}

function maybePrunePending(store) {
  if (Math.random() > 0.05) return;
  const dir = path.join(store, 'pending');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of names) {
    const p = path.join(dir, file);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > PENDING_TTL_MS) fs.unlinkSync(p);
    } catch {}
  }
}

function appendEvents(store, events) {
  if (!events.length) return;
  fs.appendFileSync(path.join(store, 'log.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
}

function readRecentEvents(store) {
  const p = path.join(store, 'log.jsonl');
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, p);
  } catch {
    removeFile(tmp);
  }
}

function removeFile(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

// ---------------------------------------------------------------- entry

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    main(JSON.parse(raw));
  } catch (e) {
    if (storeForErrors) {
      try {
        fs.appendFileSync(
          path.join(storeForErrors, 'hook-errors.log'),
          `${new Date().toISOString()} ${(e && e.stack) || e}\n`,
        );
      } catch {}
    }
  }
  process.exit(0);
});
