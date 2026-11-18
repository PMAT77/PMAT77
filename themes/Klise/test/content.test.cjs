const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Hexo = require('hexo');
const moment = require('moment');
const { JSDOM } = require('jsdom');
const yaml = require('js-yaml');
const { plainText, preparePosts, booksFor, projectsFor } = require('../lib/content.cjs');

const themeDir = path.resolve(__dirname, '..');
const siteDir = path.resolve(themeDir, '../..');

test('untitled essays use readable Unicode text and preserve the source slug', () => {
  const posts = [
    { raw: '---\ncontent_type: essay\n---\n正文', content_type: 'essay', title: 'filename', slug: 'stable-id', content: '<p>&lt;标签&gt; &amp; 🙂</p><p>第二段</p>', date: moment('2026-01-01') },
    { raw: '---\ntitle: "  "\n---', content: '', date: moment('2026-01-02') },
    { raw: '---\ntitle: 原标题\n---', content: '<p>正文</p>', date: moment() },
    { raw: '---\ntitle: ""\n---', content: '<p>' + '🙂'.repeat(40) + '</p>', date: moment() }
  ];
  preparePosts(posts);
  assert.equal(posts[0].title, '<标签> & 🙂 第二段');
  assert.equal(posts[0].slug, 'stable-id');
  assert.equal(posts[0].untitled_essay, true);
  assert.equal(posts[1].title, '2026-01-02');
  assert.equal(posts[2].title, '原标题');
  assert.equal(posts[2].untitled_essay, false);
  assert.equal(Array.from(posts[3].title).length, 30);
  preparePosts(posts);
  assert.equal(posts[0].untitled_essay, true, 'a second build must not turn the generated label into an authored title');
  assert.equal(plainText('<script>hidden</script><p>Hello<br>world</p>'), 'Hello world');
});

test('novels sort by chapter order, isolate books and keep lore out of chapters', () => {
  const post = (book, section, order, date) => ({ content_type: 'novel', novel_id: book, novel_section: section, chapter_order: order, date: moment(date), source: `${book}-${section}-${order}` });
  const posts = [post('a', 'chapter', 2, '2020-01-01'), post('b', 'chapter', 1, '2026-01-01'), post('a', 'lore', undefined, '2026-02-01'), post('a', 'chapter', 0, '2025-01-01')];
  const definitions = [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }];
  const [a, b] = booksFor(posts, definitions);
  assert.deepEqual(a.chapters.map(p => p.chapter_order), [0, 2]);
  assert.equal(a.lore.length, 1);
  assert.equal(b.chapters.length, 1);
  assert.equal(a.latest.chapter_order, 2);
  assert.throws(() => booksFor([...posts, posts[0]], definitions), /chapter_order 不能重复/);
  assert.throws(() => booksFor(posts, [{ id: 'b', title: '乙' }]), /novel_id/);
  assert.throws(() => booksFor([], [{ title: '缺少 id' }]), /唯一的小写英文 id/);
  assert.throws(() => projectsFor([{ title: 'Bad', cover: '/image.png', github: 'javascript:alert(1)' }]), /GitHub/);
});

test('Hexo generates collections, feeds, navigation and project links at both deployment roots', async t => {
  for (const root of ['/PMAT77/', '/']) {
    await t.test(root, async t => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'klise-content-test-'));
      const write = (name, data) => {
        const target = path.join(base, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      };
      fs.mkdirSync(path.join(base, 'themes'));
      fs.symlinkSync(themeDir, path.join(base, 'themes/Klise'), 'junction');
      fs.symlinkSync(path.join(siteDir, 'node_modules'), path.join(base, 'node_modules'), 'junction');
      fs.cpSync(path.join(siteDir, 'scaffolds'), path.join(base, 'scaffolds'), { recursive: true });
      write('package.json', fs.readFileSync(path.join(siteDir, 'package.json')));
      const { permalink } = yaml.load(fs.readFileSync(path.join(siteDir, '_config.yml'), 'utf8'));
      write('_config.yml', `title: Test\nauthor: Author\nurl: https://example.test${root}\ntheme: Klise\npermalink: ${permalink}\nindex_generator:\n  per_page: 0\nper_page: 0\nfuture: true\ngithub_projects:\n  enable: true\n  username: example\n`);
      write('source/_data/novels.yml', '- id: book-a\n  title: 作品甲\n- id: book-b\n  title: 作品乙\n');
      write('source/_data/projects.yml', '- title: 项目甲\n  cover: /images/project.svg\n  github: https://github.com/example/project-a\n- title: 项目乙\n  github: https://github.com/example/project-b\n');
      write('data/github-projects.json', JSON.stringify({ username: 'example', projects: ['project-a', 'project-b'].map((name, i) => ({
        name, full_name: `example/${name}`, github: `https://github.com/example/${name}`, description: '自动项目简介',
        language: 'JavaScript', stars: 3, default_branch: 'main', pushed_at: `2026-01-0${2 - i}T00:00:00Z`,
        readme: i ? null : { path: 'docs/README.md', sha: 'sha',
          html: '<h2 id="user-content-start">开始</h2><a href="#start">目录</a><a href="guide.md">指南</a><img src="../images/app.png"><pre><code>long code line</code></pre>' }
      })) }));
      t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline fixture: tests must not access GitHub'); });
      write('source/images/project.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect fill="#f66" width="640" height="360"/></svg>');
      write('source/categories/index.md', '---\nlayout: category\ntitle: 分类\n---');
      function post(name, header, body) {
        write(`source/_posts/${name}.md`, `---\n${header}\n---\n${body}`);
      }
      post('stable-untitled', 'content_type: essay\ndate: 2026-10-28\ncategories: 笔记\ntags: 笔记', '正文 &lt;标签&gt; **加粗** 🙂\n\n<!--more-->\n\n只在详情中的后半段。');
      post('empty-note', 'content_type: essay\ntitle: ""\ndate: 2026-10-27', '');
      for (let i = 1; i <= 10; i++) post(`essay-${i}`, `title: 随笔${i}\ncontent_type: essay\ndate: 2025-01-${String(i).padStart(2, '0')}`, `第${i}条随笔。`);
      post('technical', 'title: 技术标题\ncontent_type: tech\ndate: 2026-01-01\ntags: [技术标签]', '## 标题一\n\n```js\nconsole.log(1);\n```');
      post('a-second', 'title: 甲第二章\ncontent_type: novel\nnovel_id: book-a\nnovel_section: chapter\nchapter_order: 2\ndate: 2024-01-01', '甲第二章正文。');
      post('a-first', 'title: 甲第一章\ncontent_type: novel\nnovel_id: book-a\nnovel_section: chapter\nchapter_order: 1\ndate: 2026-09-01', '甲第一章正文。');
      post('a-lore', 'title: 角色卡\ncontent_type: novel\nnovel_id: book-a\nnovel_section: lore\ndate: 2026-09-02', '角色设定。');
      post('b-first', 'title: 乙第一章\ncontent_type: novel\nnovel_id: book-b\nnovel_section: chapter\nchapter_order: 1\ndate: 2026-09-03', '乙第一章正文。');
      const hexo = new Hexo(base, { silent: true });
      t.after(async () => {
        await hexo.exit();
        // base is a freshly created child of the OS temp directory; rm unlinks junctions.
        assert.equal(path.dirname(base), os.tmpdir());
        fs.rmSync(base, { recursive: true, force: true });
      });
      await hexo.init();
      await hexo.call('generate');
      const originalPaths = new Map(hexo.locals.get('posts').toArray().map(p => [p.slug, p.path]));
      const originalRoutes = hexo.route.list().sort();
      assert.equal(originalPaths.get('technical'), '2026/01/01/technical/');
      for (const post of hexo.locals.get('posts').toArray()) {
        // Keep one legacy root-level post to check both layouts together.
        if (post.slug === 'empty-note') continue;
        const target = path.join(base, 'source/_posts', post.content_type, path.basename(post.source));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(path.join(base, 'source', post.source), target);
      }
      write('source/_drafts/unpublished.md', '---\ncontent_type: essay\ndate: 2026-01-01\n---\n未发布草稿');
      await hexo.call('generate');
      const migrated = hexo.locals.get('posts').toArray();
      assert.equal(migrated.length, originalPaths.size, 'nested posts must not be lost or duplicated, and drafts must stay unpublished');
      for (const post of migrated) {
        assert.equal(post.path, originalPaths.get(path.posix.basename(post.slug)), `${post.source}: moving directories must preserve the URL`);
      }
      assert.deepEqual(hexo.route.list().sort(), originalRoutes, 'migration must preserve all deployment routes');
      const html = name => fs.readFileSync(path.join(base, 'public', name), 'utf8');
      const dom = name => new JSDOM(html(name)).window.document;
      const posts = hexo.locals.get('posts').toArray();
      const bySlug = slug => posts.find(p => path.posix.basename(p.slug) === slug);
      const detail = slug => dom(`${bySlug(slug).path}index.html`);
      const essay = dom('essays/index.html');
      assert.equal(essay.querySelectorAll('.essay-entry').length, 10);
      assert.equal(dom('essays/page/2/index.html').querySelectorAll('.essay-entry').length, 2);
      assert.ok(essay.querySelector('.read-more'));
      assert.equal(essay.querySelectorAll('.read-more').length, 1, 'full short notes must not get a redundant read-more link');
      assert.ok(!essay.querySelector('.essay-body').textContent.includes('后半段'));
      assert.ok(detail('stable-untitled').querySelector('.page-content').textContent.includes('后半段'));
      assert.ok(detail('stable-untitled').querySelector('h1.visually-hidden'));
      assert.ok(!detail('stable-untitled').querySelector('h1.header-title'));
      assert.equal(bySlug('empty-note').title, '2026-10-27');
      const label = bySlug('stable-untitled').title;
      assert.ok(dom('index.html').querySelector('main').textContent.includes(label));
      assert.ok(dom('archives/index.html').body.textContent.includes(label));
      assert.ok(dom('categories/笔记/index.html').body.textContent.includes(label));
      assert.ok(dom('tags/笔记/index.html').body.textContent.includes(label));
      assert.ok(JSON.parse(html('search.json')).some(p => p.title === label));
      assert.ok(JSON.parse(html('search.json')).every(p => p.url.startsWith(root)), 'search results should stay on the current deployment');
      assert.ok(new JSDOM(html('atom.xml'), { contentType: 'text/xml' }).window.document.documentElement.textContent.includes(label));
      assert.deepEqual(JSON.parse(html('tech-search.json')).map(p => p.title), ['技术标题']);
      assert.equal(dom('tech/index.html').querySelectorAll('.tech-entry').length, 1);
      assert.ok(detail('technical').querySelector('.article-toc a'));
      const directory = dom('novels/book-a/index.html');
      assert.deepEqual([...directory.querySelectorAll('.chapter-list a span')].map(a => a.textContent), ['甲第一章', '甲第二章']);
      assert.equal(directory.querySelectorAll('.lore-list a').length, 1);
      assert.ok(detail('a-first').querySelector('.novel-navigation [rel="next"]').textContent.includes('甲第二章'));
      assert.ok(!detail('a-first').querySelector('.novel-navigation [rel="prev"]'));
      assert.ok(!detail('b-first').querySelector('.novel-navigation [rel]'));
      assert.equal(detail('a-lore').querySelectorAll('.novel-navigation a').length, 1);
      assert.equal(detail('a-first').querySelector('[aria-current="page"]').textContent.trim(), '连载小说');
      assert.equal(detail('technical').querySelector('[aria-current="page"]').textContent.trim(), '技术文章');
      const projects = dom('projects/index.html');
      assert.deepEqual([...projects.querySelectorAll('.project-card')].map(a => a.getAttribute('href')), [`${root}projects/project-a/`, `${root}projects/project-b/`]);
      assert.equal(projects.querySelector('.project-card').target, '');
      assert.equal(projects.querySelector('.project-cover img').getAttribute('src'), `${root}images/project.svg`);
      assert.equal(projects.querySelector('.project-cover-name').textContent, '项目乙');
      const project = dom('projects/project-a/index.html');
      assert.equal(project.querySelector('.project-github').href, 'https://github.com/example/project-a');
      assert.equal(project.querySelector('.collection-back').getAttribute('href'), `${root}projects/`);
      assert.equal(project.querySelector('[aria-current="page"]').textContent.trim(), '项目展示');
      assert.ok(project.querySelector('.project-readme #start'));
      assert.equal(project.querySelector('.project-readme img').src, 'https://raw.githubusercontent.com/example/project-a/main/images/app.png');
      assert.ok(dom('projects/project-b/index.html').querySelector('.collection-empty').textContent.includes('README'));
      assert.ok(!JSON.parse(html('search.json')).some(p => p.url.includes('/projects/')));
      assert.ok(!html('atom.xml').includes('projects/project-a'));

      // Check generated local links and resource paths against actual Hexo output.
      const routes = new Set(hexo.route.list());
      for (const route of [...routes].filter(p => p.endsWith('.html'))) {
        const document = dom(route);
        for (const element of document.querySelectorAll('a[href], script[src], link[href], img[src]')) {
          const href = element.getAttribute('href') || element.getAttribute('src');
          const url = new URL(href, `https://example.test${root}${route}`);
          if (url.origin !== 'https://example.test') continue;
          if (url.pathname === root.slice(0, -1)) url.pathname += '/';
          assert.ok(url.pathname.startsWith(root), `${route}: missing site root in ${href}`);
          const target = decodeURIComponent(url.pathname.slice(root.length));
          assert.ok(routes.has(target) || routes.has(`${target}index.html`), `${route}: broken link ${href}`);
        }
      }
      await hexo.call('generate');
      assert.ok(detail('stable-untitled').querySelector('h1.visually-hidden'));
      await hexo.call('new', { _: ['essay', '20261028-153000'], path: 'essay/20261028-153000.md' });
      await hexo.call('generate');
      const created = hexo.locals.get('posts').findOne({ source: '_posts/essay/20261028-153000.md' });
      assert.equal(created.content_type, 'essay');
      assert.equal(created.untitled_essay, true);
      assert.equal(created.layout, 'post');
      assert.ok(dom(`${created.path}index.html`).querySelector('h1.visually-hidden'));
    });
  }
});
