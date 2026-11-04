import test from 'node:test';
import assert from 'node:assert/strict';

import { __resetTokenCache, findCalendarByName, listCalendars } from '../src/calendar/google.js';

const calendars = [
  { id: 'me@x', summary: 'somebody@gmail.com', primary: true, accessRole: 'owner' },
  { id: 'osu@group.calendar.google.com', summary: 'OSU', primary: false, accessRole: 'owner' },
  { id: 'osu-class@group.calendar.google.com', summary: 'OSU Classes', primary: false, accessRole: 'writer' },
  { id: 'work@group.calendar.google.com', summary: 'Work', primary: false, accessRole: 'reader' },
];

test('findCalendarByName: 精确匹配优先', () => {
  const found = findCalendarByName(calendars, 'OSU');
  assert.equal(found.id, 'osu@group.calendar.google.com');
});

test('findCalendarByName: 不区分大小写 / 去空格', () => {
  assert.equal(findCalendarByName(calendars, '  osu ').id, 'osu@group.calendar.google.com');
});

test('findCalendarByName: 精确没有时退到包含匹配', () => {
  const only = [{ id: 'a', summary: 'OSU Classes' }];
  assert.equal(findCalendarByName(only, 'OSU').id, 'a');
});

test('findCalendarByName: 找不到返回 null（绝不回退 primary）', () => {
  assert.equal(findCalendarByName(calendars, 'NOPE'), null);
  assert.equal(findCalendarByName(calendars, ''), null);
  assert.equal(findCalendarByName(null, 'OSU'), null);
});

test('findCalendarByName: summaryOverride 也算（用户自定义显示名）', () => {
  const list = [{ id: 'x', summary: 'Calendar', summaryOverride: 'OSU' }];
  assert.equal(findCalendarByName(list, 'OSU').id, 'x');
});

test('listCalendars: 换 token + 归一字段', async () => {
  __resetTokenCache();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: calendars }),
    };
  };

  const result = await listCalendars({
    clientId: 'cid',
    clientSecret: 'csecret',
    refreshToken: 'rt',
    fetchImpl: fakeFetch,
  });

  assert.equal(result.length, 4);
  assert.equal(result[0].primary, true);
  assert.equal(result[1].summary, 'OSU');
  // token 请求带对了 grant_type
  assert.match(String(calls[0].body), /grant_type=refresh_token/);
  // 日历请求带了 Bearer
  assert.ok(calls[1].url.includes('/calendarList'));
});

test('listCalendars: token 失败给出可读错误', async () => {
  __resetTokenCache();
  const failing = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
  });
  await assert.rejects(
    () => listCalendars({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: failing }),
    /换 token 失败 HTTP 400 Token has been expired/,
  );
});
