// Follows Claude Code session transcripts for title entries. A rename (`/rename`, `claude -n`)
// appends {"type":"custom-title","customTitle":…}; generated titles are looked for in any small
// entry whose type mentions a title. The transcript format is internal to Claude Code, so
// anything unrecognised is ignored. Only bytes added since the last look are read.

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

export interface SessionTitles {
  /** The name given by hand; the latest one wins. */
  custom: string;
  /** A title Claude Code generated. */
  generated: string;
  summary: string;
}

interface Followed {
  offset: number;
  rest: string;
  decoder: StringDecoder;
  titles: SessionTitles;
}

const CHUNK = 4 * 1024 * 1024;

export class TitleWatcher {
  private readonly files = new Map<string, Followed>();

  read(file: string): SessionTitles {
    let f = this.files.get(file);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return f?.titles ?? { custom: '', generated: '', summary: '' };
    }
    if (!f || size < f.offset) {
      f = { offset: 0, rest: '', decoder: new StringDecoder('utf8'), titles: { custom: '', generated: '', summary: '' } };
      this.files.set(file, f);
    }
    if (size === f.offset) return f.titles;

    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - f.offset));
      while (f.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - f.offset), f.offset);
        if (n <= 0) break;
        f.offset += n;
        const lines = (f.rest + f.decoder.write(buf.subarray(0, n))).split('\n');
        f.rest = lines.pop() ?? '';
        for (const line of lines) scanLine(line, f.titles);
        if (f.rest.length > 64 * 1024) f.rest = ''; // a long message line, never a title entry
      }
    } finally {
      fs.closeSync(fd);
    }
    return f.titles;
  }
}

function scanLine(line: string, titles: SessionTitles): void {
  if (line.length > 4000) return;
  const m = /"type":"([\w-]*title[\w-]*|summary)"/i.exec(line);
  if (!m) return;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const value = [entry.customTitle, entry.aiTitle, entry.title, entry.summary]
    .concat(Object.entries(entry).filter(([k]) => /title$/i.test(k)).map(([, v]) => v))
    .find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (!value) return;
  const type = m[1].toLowerCase();
  const clean = value.replace(/\s+/g, ' ').trim();
  if (type === 'custom-title') titles.custom = clean;
  else if (type === 'summary') titles.summary = clean;
  else titles.generated = clean;
}
