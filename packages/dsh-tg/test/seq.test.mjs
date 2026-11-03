import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSeqStore } from '../src/seq.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-seq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ITEMS = [
  { id: 'canvas:assignment:1', title: '作业一', course: 'CS 101', dueAt: '2026-11-05T04:59:59.000Z' },
  { id: 'canvas:assignment:2', title: '作业二', course: null, dueAt: null },
];

test('assign: 序号从 1 开始，按展示顺序落盘；resolve 能取回 id', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'seq.json');
  const store = createSeqStore({ file });

  const count = store.assign(ITEMS, { source: 'list', at: '2026-11-03T00:00:00.000Z' });
  assert.equal(count, 2);
  assert.deepEqual(store.resolve(1), {
    index: 1,
    id: 'canvas:assignment:1',
    title: '作业一',
    course: 'CS 101',
    dueAt: '2026-11-05T04:59:59.000Z',
  });
  assert.equal(store.resolve(2).id, 'canvas:assignment:2');
  assert.equal(store.resolve(3), null);

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.at, '2026-11-03T00:00:00.000Z');
  assert.equal(raw.source, 'list');
  assert.equal(raw.items['1'].id, 'canvas:assignment:1');
});

test('assign: 重启后仍能解析（/done 跨重启有效）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'seq.json');
  createSeqStore({ file }).assign(ITEMS, { source: 'next' });

  const reloaded = createSeqStore({ file });
  assert.equal(reloaded.size, 2);
  assert.equal(reloaded.resolve(1).id, 'canvas:assignment:1');
});

test('assign: 每次重新分配并整体覆盖（序号只认最近一次清单）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'seq.json');
  const store = createSeqStore({ file });
  store.assign(ITEMS);
  store.assign([{ id: 'canvas:assignment:9', title: '新清单' }]);

  assert.equal(store.size, 1);
  assert.equal(store.resolve(1).id, 'canvas:assignment:9');
  assert.equal(store.resolve(2), null);
});

test('assign: 没有 id 的条目跳过；映射文件损坏时忽略旧映射而不是崩溃', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'seq.json');
  const store = createSeqStore({ file });
  store.assign([{ id: '', title: 'x' }, ITEMS[0]]);
  assert.equal(store.size, 1);
  // 序号跟回复里的展示位置一致（第 2 条），不是压缩后的 1
  assert.equal(store.resolve(2).id, 'canvas:assignment:1');
  assert.equal(store.resolve(1), null);

  writeFileSync(file, '{broken');
  const reloaded = createSeqStore({ file });
  assert.equal(reloaded.size, 0);
  assert.equal(reloaded.resolve(1), null);
});

test('file=null: 纯内存可用', () => {
  const store = createSeqStore({ file: null });
  store.assign(ITEMS);
  assert.equal(store.resolve(2).title, '作业二');
});

test('写盘失败不抛（只在内存里生效）', () => {
  const failingFs = {
    readFileSync: () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeFileSync: () => {
      throw new Error('disk full');
    },
    renameSync: () => {},
    mkdirSync: () => {},
    rmSync: () => {},
  };
  const store = createSeqStore({ file: '/fake/seq.json', fs: failingFs });
  assert.doesNotThrow(() => store.assign(ITEMS));
  assert.equal(store.resolve(1).id, 'canvas:assignment:1');
});
