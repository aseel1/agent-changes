import { spawn } from 'child_process';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
}

export function git(cwd: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(args, code, Buffer.concat(err).toString('utf8')));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Reads many blobs in one process. Specs look like "HEAD:path" or ":path" (index). */
export async function readBlobs(cwd: string, specs: string[]): Promise<Map<string, Buffer | null>> {
  const result = new Map<string, Buffer | null>();
  if (!specs.length) return result;
  const out = await git(cwd, ['cat-file', '--batch'], specs.join('\n') + '\n');
  let pos = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (parts.length !== 3 || Number.isNaN(size)) {
      result.set(spec, null); // "<spec> missing" / "ambiguous"
      continue;
    }
    result.set(spec, parts[1] === 'blob' ? out.subarray(pos, pos + size) : null);
    pos += size + 1;
  }
  return result;
}

/** Paths git reports as changed (staged, unstaged or untracked), relative to the repo root. */
export async function changedPaths(root: string): Promise<string[]> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      i++;
      if (parts[i]) paths.push(parts[i]);
    }
  }
  return paths;
}
