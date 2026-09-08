import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/sshExec', () => ({ sshExec: vi.fn(), shQuote: (s: string) => s }));
import { CODEX_BG_STATE_PY } from '@/lib/server/claude/codexBgState';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function observe(content: string, parent = 'parent') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-codex-bg-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'child.jsonl'), content);
  const setup = `
import sqlite3, json, os
from pathlib import Path
home = Path(os.environ['TEST_HOME'])
db = sqlite3.connect(home / 'state_5.sqlite')
db.execute('CREATE TABLE threads (id TEXT, source TEXT, rollout_path TEXT)')
db.execute('INSERT INTO threads VALUES (?,?,?)', ('child', json.dumps({'subagent': {'thread_spawn': {'parent_thread_id': os.environ['TEST_PARENT']}}}), str(home / 'child.jsonl')))
db.commit()
db.close()
`;
  const output = execFileSync('python3', ['-c', setup + CODEX_BG_STATE_PY], {
    encoding: 'utf8', env: { ...process.env, TEST_HOME: dir, TEST_PARENT: parent,
      CHARON_BG_REQUEST: JSON.stringify({ parentId: 'parent', taskIds: ['child'], codexHome: dir }) },
  });
  return JSON.parse(output).tasks;
}

function event(type: string, second: number) {
  return JSON.stringify({ type: 'event_msg', timestamp: `2026-09-08T00:00:${String(second).padStart(2, '0')}Z`, payload: { type } }) + '\n';
}

describe('native Codex child lifecycle receipts', () => {
  it('uses task_complete after ordinary item-completed activity', () => {
    expect(observe(event('task_started', 1) + event('item_completed', 2) + event('task_complete', 3)))
      .toMatchObject([{ taskId: 'child', status: 'completed' }]);
  });
  it('keeps a child running when a follow-up turn started after its prior completion', () => {
    expect(observe(event('task_complete', 1) + event('task_started', 2)))
      .toMatchObject([{ status: 'running' }]);
  });
  it('does not equate a tool completion with a child completion', () => {
    expect(observe(event('task_started', 1) + event('item_completed', 2)))
      .toMatchObject([{ status: 'running' }]);
  });
  it('distinguishes interruption from success', () => {
    expect(observe(event('task_started', 1) + event('turn_aborted', 2)))
      .toMatchObject([{ status: 'killed' }]);
  });
  it('never treats missing/partial/corrupt evidence or an unrelated child as finished', () => {
    expect(observe('')).toEqual([]);
    expect(observe(event('task_complete', 1) + '{"type":')).toEqual([]);
    expect(observe(event('task_complete', 1) + 'corrupt\n')).toEqual([]);
    expect(observe(event('task_complete', 1), 'someone-else')).toEqual([]);
  });
  it('reads the bounded tail even behind a huge tool output', () => {
    expect(observe(JSON.stringify({ type: 'response_item', text: 'x'.repeat(1100000) }) + '\n'
      + event('task_complete', 2))).toMatchObject([{ status: 'completed' }]);
  });
});
