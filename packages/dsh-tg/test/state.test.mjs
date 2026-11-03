import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../src/state.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('offset: 落盘后新实例能读回（重启不重复消费）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'tg-state.json');

  const first = createStateStore({ file });
  assert.equal(first.offset, null);
  first.setOffset(100);
  first.setOffset(101);
  assert.equal(first.offset, 101);

  const second = createStateStore({ file });
  assert.equal(second.offset, 101);

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.offset, 101);
  assert.equal(raw.version, 1);
});

test('offset: 只前进（旧值/重放不会把 offset 拉回去）', (t) => {
  const dir = tempDir(t);
  const store = createStateStore({ file: join(dir, 'state.json') });
  store.setOffset(50);
  store.setOffset(10);
  assert.equal(store.offset, 50);
  store.setOffset('not-a-number');
  assert.equal(store.offset, 50);
});

test('offset: 每次写盘都是原子 rename，不留 .tmp', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  const store = createStateStore({ file });
  store.setOffset(7);
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.equal(statSync(file).size > 0, true);
});

test('状态文件损坏 / 缺字段时按空状态启动，不抛异常', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{broken');
  const store = createStateStore({ file });
  assert.equal(store.offset, null);
  store.setOffset(3);
  assert.equal(createStateStore({ file }).offset, 3);

  writeFileSync(file, JSON.stringify({ version: 1, offset: 'abc' }));
  assert.equal(createStateStore({ file }).offset, null);
});

test('告警限频时间戳持久化 / 清除', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  const store = createStateStore({ file });
  assert.equal(store.getAlertAt('heartbeat'), null);
  store.setAlertAt('heartbeat', 12345);
  assert.equal(store.getAlertAt('heartbeat'), 12345);

  const reloaded = createStateStore({ file });
  assert.equal(reloaded.getAlertAt('heartbeat'), 12345);
  reloaded.clearAlert('heartbeat');
  assert.equal(reloaded.getAlertAt('heartbeat'), null);

  reloaded.setAlertAt('auth', 1);
  reloaded.setAlertAt('conflict', 2);
  reloaded.clearAlerts();
  assert.equal(reloaded.getAlertAt('auth'), null);
  assert.equal(reloaded.getAlertAt('conflict'), null);
});

test('file=null 时纯内存运行，不碰磁盘', () => {
  const store = createStateStore({ file: null });
  store.setOffset(9);
  assert.equal(store.offset, 9);
  store.setAlertAt('heartbeat', 5);
  assert.equal(store.getAlertAt('heartbeat'), 5);
  store.flush();
});

test('写盘失败不抛（服务继续跑）', () => {
  const failingFs = {
    readFileSync: () => {
      const error = new Error('nope');
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
  const store = createStateStore({ file: '/fake/state.json', fs: failingFs });
  assert.doesNotThrow(() => store.setOffset(5));
  assert.equal(store.offset, 5);
});
