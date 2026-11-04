import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deepseekFetch,
  deepseekSearch,
  parseDuckDuckGoHtml,
  reconstructAbstract,
  searchPapers,
} from '../src/chat/web.js';

const jsonFetch = (capture, body, ok = true, status = 200) => async (url, init) => {
  capture.url = String(url);
  capture.method = init?.method;
  capture.body = init?.body ? JSON.parse(init.body) : null;
  capture.auth = init?.headers?.authorization;
  return { ok, status, text: async () => JSON.stringify(body) };
};

test('deepseekSearch: 打到 /v1/tools/search，带 Bearer 和 need_content=false', async () => {
  const captured = {};
  const result = await deepseekSearch({
    apiKey: 'sk-x',
    query: 'Han-Wei Shen',
    count: 3,
    fetchImpl: jsonFetch(captured, {
      results: [
        { title: 'T1', url: 'https://a', summary: 'S1', snippet: 'sn1', date: '2026-01-01', authority: 3 },
      ],
    }),
  });

  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.auth, 'Bearer sk-x');
  assert.equal(captured.body.need_content, false);
  assert.equal(captured.body.count, 3);
  assert.equal(result.count, 1);
  assert.equal(result.billed, true);
  assert.equal(result.results[0].title, 'T1');
});

test('deepseekSearch: 空结果 → billed=false（不花钱）', async () => {
  const result = await deepseekSearch({
    apiKey: 'sk-x',
    query: 'nothing',
    fetchImpl: jsonFetch({}, { results: [] }),
  });
  assert.equal(result.count, 0);
  assert.equal(result.billed, false);
});

test('deepseekSearch: count 被夹到 1..20', async () => {
  const captured = {};
  await deepseekSearch({ apiKey: 'sk-x', query: 'q', count: 999, fetchImpl: jsonFetch(captured, { results: [] }) });
  assert.equal(captured.body.count, 20);
});

test('deepseekSearch: HTTP 错误带上游 message，且不泄露 key', async () => {
  const failing = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'QPS exceeded' } }),
  });
  await assert.rejects(
    () => deepseekSearch({ apiKey: 'sk-secret', query: 'q', fetchImpl: failing }),
    (error) => {
      assert.match(error.message, /HTTP 429 QPS exceeded/);
      assert.ok(!error.message.includes('sk-secret'));
      return true;
    },
  );
});

test('deepseekSearch: 缺参数校验', async () => {
  await assert.rejects(() => deepseekSearch({ query: 'q' }), /apiKey is required/);
  await assert.rejects(() => deepseekSearch({ apiKey: 'k', query: '  ' }), /query is required/);
});

test('deepseekFetch: 打到 /v1/tools/fetch 并截断内容', async () => {
  const captured = {};
  const result = await deepseekFetch({
    apiKey: 'sk-x',
    url: 'https://example.com/a',
    fetchImpl: jsonFetch(captured, { title: 'T', content: 'x'.repeat(20000) }),
  });
  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(result.title, 'T');
  assert.equal(result.content.length, 12000);
});

test('deepseekFetch: 拒绝非 http(s)', async () => {
  await assert.rejects(() => deepseekFetch({ apiKey: 'k', url: 'file:///etc/passwd' }), /http\(s\)/);
});

test('reconstructAbstract: 倒排索引还原', () => {
  const text = reconstructAbstract({ Hello: [0], world: [1], again: [2] });
  assert.equal(text, 'Hello world again');
  assert.equal(reconstructAbstract(null), null);
  assert.equal(reconstructAbstract({}), null);
});

test('searchPapers: 先找作者再拉他的论文（不串到别人）', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/authors?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 'https://openalex.org/A123', display_name: 'Han-Wei Shen', works_count: 300 }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            display_name: 'Paper A',
            publication_year: 2026,
            authorships: [{ author: { display_name: 'Han-Wei Shen' } }],
            abstract_inverted_index: { Deep: [0], learning: [1] },
          },
        ],
      }),
    };
  };

  const result = await searchPapers({ query: 'Han-Wei Shen', limit: 3, fetchImpl: fakeFetch });
  assert.equal(result.mode, 'author');
  assert.equal(result.author.name, 'Han-Wei Shen');
  assert.equal(result.works[0].title, 'Paper A');
  assert.equal(result.works[0].abstract, 'Deep learning');
  // 第二次请求必须是按 author.id 过滤
  assert.match(calls[1], /author\.id%3AA123|author\.id:A123/);
});

test('parseDuckDuckGoHtml: 解出 uddg 真实链接', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=1">Example <b>Title</b></a>
    <div class="result__snippet">Some snippet here</div>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/x');
  assert.equal(results[0].title, 'Example Title');
  assert.equal(results[0].snippet, 'Some snippet here');
});
