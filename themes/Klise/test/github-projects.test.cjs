const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { loadProjects, readmeHtml, projectsFor } = require('../lib/github-projects.cjs');

const config = { enable: true, username: 'example', exclude: ['hidden'] };
const repo = (name, extra = {}) => ({ name, full_name: `example/${name}`, private: false, fork: false,
  archived: false, default_branch: 'main', description: '项目简介', language: 'JavaScript',
  stargazers_count: 12, pushed_at: '2026-11-15T00:00:00Z', ...extra });
const response = (data, status = 200) => ({ ok: status === 200, status,
  json: async () => data, text: async () => data });
const log = { warn() {}, info() {} };

async function temp(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'klise-github-test-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}

test('README HTML preserves anchors and rewrites repository links without executable content', () => {
  const project = { github: 'https://github.com/example/app', full_name: 'example/app',
    default_branch: 'feature/docs', readme: { path: 'docs/README.md' } };
  const html = readmeHtml(`<div class="markdown-heading"><h2>安装</h2><a class="anchor" id="user-content-install" href="#install"></a></div><a href="#install">目录</a>
    <a href="#user-content-install">另一个目录</a><a href="guide.md#start">指南</a>
    <a href="/LICENSE">许可</a><a href="https://example.org/">外链</a>
    <img src="../images/app.png" onerror="alert(1)"><img src="/logo.png">
    <script>alert(1)</script><iframe src="https://example.org/"></iframe>
    <a href="javascript:alert(1)">坏链接</a><img src="http://[" style="position:fixed">
    <input type="checkbox" checked><pre><code>const x = '&lt;script&gt;';</code></pre>`, project);
  const document = new JSDOM(html).window.document;
  assert.ok(document.querySelector('#install'));
  assert.equal(document.querySelector('#install').tagName, 'H2', 'GitHub heading anchors should scroll to the heading itself');
  assert.deepEqual([...document.querySelectorAll('a')].slice(0, 2).map(a => a.getAttribute('href')), ['#install', '#install']);
  assert.equal(document.querySelectorAll('a')[2].href, 'https://github.com/example/app/blob/feature%2Fdocs/docs/guide.md#start');
  assert.equal(document.querySelectorAll('a')[3].href, 'https://github.com/example/app/blob/feature%2Fdocs/LICENSE');
  assert.equal(document.querySelector('img').src, 'https://raw.githubusercontent.com/example/app/feature%2Fdocs/images/app.png');
  assert.equal(document.querySelectorAll('img')[1].src, 'https://raw.githubusercontent.com/example/app/feature%2Fdocs/logo.png');
  assert.equal(document.querySelectorAll('a')[2].rel, 'noopener noreferrer');
  assert.ok(!document.querySelector('script, iframe, [onerror], [style], [href^="javascript:"]'));
  assert.ok(document.querySelector('input').disabled);
  assert.ok(document.querySelector('pre code').textContent.includes('<script>'));
  assert.equal(readmeHtml(html, project), html, 'cached HTML should remain stable across builds');
});

test('GitHub sync paginates, filters, sorts, applies overrides and saves only public data', async t => {
  const baseDir = await temp(t);
  const firstPage = [repo('old', { pushed_at: '2025-01-01T00:00:00Z' }),
    ...Array.from({ length: 99 }, (_, i) => repo(`fork-${i}`, { fork: true }))];
  const secondPage = [repo('new'), repo('example'), repo('archived', { archived: true }),
    repo('private', { private: true }), repo('hidden'), repo('other', { full_name: 'other/other' })];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, accept: options.headers.Accept });
    assert.equal(options.headers.Authorization, 'Bearer test-token-never-publish');
    if (url.includes('/users/')) return response(url.endsWith('page=1') ? firstPage : secondPage);
    if (url.includes('/old/')) return response(null, 404);
    return response(options.headers.Accept.includes('html') ? '<h2 id="user-content-start">开始</h2><a href="#start">开始</a>'
      : { path: 'README.md', sha: 'readme-sha' });
  };
  const args = { baseDir, config, log, fetchImpl, token: 'test-token-never-publish',
    overrides: [{ github: 'https://github.com/example/new/', title: '新项目', cover: '/images/app.png' }] };
  const projects = await loadProjects(args);
  assert.deepEqual(projects.map(p => p.name), ['new', 'old']);
  assert.equal(projects[0].title, '新项目');
  assert.equal(projects[0].cover, '/images/app.png');
  assert.equal(projects[0].stars, 12);
  assert.equal(projects[0].path, 'projects/new/');
  assert.ok(projects[0].readme.html.includes('id="start"'));
  assert.equal(projects[1].readme, null);
  const cache = await fs.readFile(path.join(baseDir, 'data/github-projects.json'), 'utf8');
  assert.ok(!cache.includes('test-token-never-publish'));
  assert.ok(!cache.includes('example/private'));
  assert.equal(calls.filter(call => call.url.includes('/users/')).length, 2);
  assert.equal(calls.filter(call => call.accept.includes('html')).length, 1);
  calls.length = 0;
  await loadProjects(args);
  assert.equal(calls.filter(call => call.accept.includes('html')).length, 0, 'unchanged README reuses cached HTML');

  const warnings = [];
  const fallback = await loadProjects({ ...args, config: { ...config, exclude: ['old'] },
    log: { ...log, warn: text => warnings.push(text) }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(fallback.map(p => p.name), ['new']);
  assert.equal(fallback[0].readme.html, projects[0].readme.html);
  assert.ok(warnings.length);
  assert.equal(await fs.readFile(path.join(baseDir, 'data/github-projects.json'), 'utf8'), cache,
    'failed list requests must not overwrite the successful snapshot');
});

test('README failures reuse previous content, but a confirmed missing README clears it', async t => {
  const baseDir = await temp(t);
  const cached = { ...repo('app'), github: 'https://github.com/example/app', stars: 2,
    readme: { path: 'README.md', sha: 'old', html: '<p>已有内容</p>' } };
  await fs.mkdir(path.join(baseDir, 'data'));
  await fs.writeFile(path.join(baseDir, 'data/github-projects.json'), JSON.stringify({ username: 'example', projects: [cached] }));
  for (const status of [403, 429, 500]) {
    const projects = await loadProjects({ baseDir, config, log,
      fetchImpl: async url => url.includes('/users/') ? response([repo('app')]) : response(null, status) });
    assert.equal(projects[0].readme.html, '<p>已有内容</p>');
  }
  const missing = await loadProjects({ baseDir, config, log,
    fetchImpl: async url => url.includes('/users/') ? response([repo('app')]) : response(null, 404) });
  assert.equal(missing[0].readme, null);
});

test('request and whole-sync timeouts preserve manual projects and do not block builds', async t => {
  const baseDir = await temp(t);
  const overrides = [{ github: 'https://github.com/example/app' }];
  for (const [requestTimeout, syncTimeout] of [[10, 100], [100, 10]]) {
    // Keep the test process alive while AbortSignal's unref'ed timeout fires.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const projects = await loadProjects({ baseDir, config, overrides, log, requestTimeout, syncTimeout,
        fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) });
      assert.equal(projects[0].path, 'projects/app/');
      assert.equal(projects[0].readme, null);
    } finally { clearInterval(keepAlive); }
  }
  const empty = await loadProjects({ baseDir, config, log, fetchImpl: async () => response(null, 403) });
  assert.deepEqual(empty, []);
  const manual = await loadProjects({ baseDir, overrides, log,
    fetchImpl: async () => { throw new Error('manual mode must not request GitHub'); } });
  assert.equal(manual.length, 1);
  assert.throws(() => projectsFor([{ github: 'javascript:alert(1)' }]), /GitHub/);
  assert.throws(() => projectsFor([{ github: 'https://github.com/example/app', cover: 'javascript:alert(1)' }]), /cover/);
  assert.throws(() => projectsFor([{ github: 'https://github.com/example/app' },
    { github: 'https://github.com/other/APP' }]), /重复/);
});
