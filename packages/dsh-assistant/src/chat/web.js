/**
 * 联网检索能力（零 API key）。
 *
 * 为什么要自己实现：维护者问「Shen 老师做啥的、最近发了什么文章」，
 * 助理答"我没有 web search 工具" —— 这是能力缺口，不是"帮不了"。
 *
 * 为什么用这两个源：
 *   · **OpenAlex**（`api.openalex.org`）：免费、无需 key、JSON 稳定，
 *     专门查"某位学者最近发了什么论文"。Google Scholar 会被拦，不适合自动化。
 *   · **DuckDuckGo HTML**（`html.duckduckgo.com/html/`）：无 key、无需 JS，
 *     用于"这个人/这个话题大概是什么"。结果少但够用。
 *
 * 安全：只发出站 GET，不携带任何凭据；返回内容会截断，避免把整页塞进模型。
 */

const UA = 'Mozilla/5.0 (compatible; dsh-assistant/1.0)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEEPSEEK_BASE = 'https://api.deepseek.com';

/**
 * DeepSeek 官方 Search API（**计费**：$0.75 / 1000 次成功请求，约 $0.00075/次）。
 *
 * 核实自官方文档（2026-11-04）：`POST /v1/tools/search`
 *   · 请求 `{query, count?, need_content?, ori_question?}`
 *   · 返回 results[]，每项含 title / url / snippet / summary（600-800 字，给模型读的）/
 *     content / date / authority / rerank_score
 *   · 只有 200 且 results 非空才计费
 *
 * 比自建 DuckDuckGo 抓取好得多：有 rerank 分、有长摘要、支持 `site:`/`after:` 操作符。
 */
export async function deepseekSearch({
  apiKey,
  query,
  count = 5,
  needContent = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('deepseekSearch: query is required');
  if (!apiKey) throw new Error('deepseekSearch: apiKey is required');

  // 直接 POST（Search 只接受 POST；不要多发一次 GET，那会白跑一次连接）
  return postJson({
    url: `${DEEPSEEK_BASE}/v1/tools/search`,
    body: { query: q, count: Math.min(Math.max(Number(count) || 5, 1), 20), need_content: needContent === true },
    apiKey,
    fetchImpl,
    timeoutMs,
    normalize: (body) => ({
      ok: true,
      count: (body?.results ?? []).length,
      billed: (body?.results ?? []).length > 0,
      results: (body?.results ?? []).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        summary: String(item.summary ?? item.snippet ?? '').slice(0, 1200),
        snippet: String(item.snippet ?? '').slice(0, 300),
        date: item.date ?? null,
        authority: item.authority ?? null,
        rerankScore: item.rerank_score ?? null,
        content: needContent ? String(item.content ?? '').slice(0, 4000) : null,
      })),
    }),
  });
}

/**
 * DeepSeek 官方 Fetch API（**计费**同 Search）：抓单页返回 Markdown。
 * `POST /v1/tools/fetch {url}` → `{title, content}`
 */
export async function deepseekFetch({
  apiKey,
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 25_000,
} = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('deepseekFetch: url must be http(s)');
  if (!apiKey) throw new Error('deepseekFetch: apiKey is required');

  return postJson({
    url: `${DEEPSEEK_BASE}/v1/tools/fetch`,
    body: { url: target },
    apiKey,
    fetchImpl,
    timeoutMs,
    normalize: (body) => ({
      ok: true,
      url: target,
      title: body?.title ?? '',
      content: String(body?.content ?? '').slice(0, 12_000),
    }),
  });
}

/** POST JSON 的公共实现（带超时，错误信息里不泄露 key） */
async function postJson({ url, body, apiKey, fetchImpl, timeoutMs, normalize }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* 保留原文 */
    }
    if (!response.ok) {
      const detail = parsed?.error?.message ?? raw.slice(0, 160);
      throw new Error(`deepseek tools: HTTP ${response.status} ${detail}`.split(apiKey).join('***'));
    }
    return normalize(parsed);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`deepseek tools: 超时 ${timeoutMs}ms`);
    throw new Error(String(error?.message ?? error).split(apiKey).join('***'));
  } finally {
    clearTimeout(timer);
  }
}


async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: { 'user-agent': UA, ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 OpenAlex 的 `abstract_inverted_index` 还原成文本。
 * OpenAlex 出于版权只给倒排索引（word -> [positions]）。
 */
export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const slots = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions ?? []) slots[position] = word;
  }
  const text = slots.filter(Boolean).join(' ').trim();
  return text || null;
}

/**
 * 先按名字找作者，再拉该作者的论文。
 *
 * 为什么不能直接 `works?search=人名`：那是**全文搜索**，会串到引用里提到这个名字的
 * 无关论文（实测搜 "Han-Wei Shen" 返回了地下水硝酸盐、太赫兹吸收之类的文章）。
 * 正确做法：`/authors?search=` 找到作者 id，再 `works?filter=author.id:<id>`。
 */
async function findAuthors({ query, limit = 5, fetchImpl, timeoutMs }) {
  const url =
    'https://api.openalex.org/authors?' +
    new URLSearchParams({
      search: query,
      'per-page': String(Math.min(limit, 10)),
      mailto: 'noreply@example.com',
    }).toString();
  const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
  if (!response.ok) throw new Error(`OpenAlex authors HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  return (body?.results ?? []).map((author) => ({
    id: author.id ?? null,
    name: author.display_name ?? null,
    worksCount: author.works_count ?? null,
    citedByCount: author.cited_by_count ?? null,
    lastKnownInstitutions: (author.last_known_institutions ?? [])
      .map((inst) => inst?.display_name)
      .filter(Boolean),
    topics: (author.topics ?? []).slice(0, 5).map((topic) => topic?.display_name).filter(Boolean),
  }));
}

/**
 * 查询某位学者的论文（OpenAlex）。优先按作者检索，找不到才退回全文搜索。
 *
 * @param {object} options
 * @param {string} options.query 人名（引擎会自动找作者）；也可传主题
 * @param {number} [options.limit] 论文条数，默认 5，上限 10
 * @returns {Promise<{ok:true, mode:'author'|'text', author:object|null, count:number, works:object[]}>}
 */
export async function searchPapers({
  query,
  limit = 5,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('searchPapers: query is required');
  const perPage = Math.min(Math.max(Number(limit) || 5, 1), 10);

  let author = null;
  let works = [];

  try {
    const authors = await findAuthors({ query: q, fetchImpl, timeoutMs });
    // 挑第一个"名字对得上"的作者（忽略大小写与空格差异）
    const normalized = q.toLowerCase().replace(/\s+/g, ' ');
    author =
      authors.find((a) => String(a.name ?? '').toLowerCase().replace(/\s+/g, ' ') === normalized) ??
      authors[0] ??
      null;
  } catch {
    author = null;
  }

  if (author?.id) {
    const authorId = String(author.id).replace('https://openalex.org/', '');
    const url =
      'https://api.openalex.org/works?' +
      new URLSearchParams({
        filter: `author.id:${authorId}`,
        'per-page': String(perPage),
        sort: 'publication_date:desc',
        mailto: 'noreply@example.com',
      }).toString();
    const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      works = body?.results ?? [];
    }
  }

  let mode = 'author';

  if (works.length === 0) {
    // 退路：全文搜索（可能串到别人，但在没有作者命中时比"没有结果"好）
    mode = 'text';
    const url =
      'https://api.openalex.org/works?' +
      new URLSearchParams({
        search: q,
        'per-page': String(perPage),
        sort: 'publication_date:desc',
        mailto: 'noreply@example.com',
      }).toString();
    const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
    if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    works = body?.results ?? [];
  }

  const normalizedWorks = works.map((work) => ({
    title: work.display_name ?? work.title ?? '(无标题)',
    year: work.publication_year ?? null,
    date: work.publication_date ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    doi: work.doi ?? null,
    citations: work.cited_by_count ?? null,
    authors: (work.authorships ?? [])
      .slice(0, 6)
      .map((a) => a.author?.display_name)
      .filter(Boolean),
    abstract: reconstructAbstract(work.abstract_inverted_index)?.slice(0, 800) ?? null,
  }));

  return { ok: true, mode, author, count: normalizedWorks.length, works: normalizedWorks };
}

/** 从 DuckDuckGo 的 HTML 结果页里抽 {title, url, snippet} */
export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = blockRe.exec(String(html ?? ''))) !== null) {
    const rawUrl = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    // DDG 会把真实地址藏在 uddg 参数里
    let url = rawUrl;
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        /* 保留原样 */
      }
    }
    results.push({ title, url });
  }

  // 摘要单独抓（结构上是 result__snippet 的兄弟节点，用宽松匹配）
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  let index = 0;
  while ((match = snippetRe.exec(String(html ?? ''))) !== null && index < results.length) {
    const snippet = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (snippet) results[index].snippet = snippet.slice(0, 300);
    index += 1;
  }

  return results;
}

/**
 * 通用网页搜索（DuckDuckGo HTML，无 key）。
 * @returns {Promise<{ok:true, count:number, results:object[]}>}
 */
export async function webSearch({
  query,
  limit = 5,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('webSearch: query is required');

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
  if (!response.ok) throw new Error(`duckduckgo HTTP ${response.status}`);

  const html = await response.text();
  const all = parseDuckDuckGoHtml(html);
  const results = all.slice(0, Math.min(Math.max(Number(limit) || 5, 1), 10));
  return { ok: true, count: results.length, results };
}
