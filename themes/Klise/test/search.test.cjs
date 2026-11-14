const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const ejs = require('ejs');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const { url_for } = require('hexo-util');

const themeDir = path.resolve(__dirname, '..');
const scripts = fs.readFileSync(path.join(themeDir, 'layout/partials/scripts.ejs'), 'utf8');
const library = fs.readFileSync(path.join(themeDir, 'source/js/search.js'));
const posts = [{ title: '第一章 - 启航 <script>文字</script> & "引号"', tags: '小说, Novel', url: '/article/' }];

test('archive search loads its index and handles input before it arrives', async (t) => {
  for (const { root, technical } of [
    { root: '/PMAT77/', technical: false }, { root: '/', technical: false },
    { root: '/PMAT77/', technical: true }, { root: '/', technical: true }
  ]) {
    await t.test(`${root} ${technical ? 'tech' : 'archive'}`, async () => {
      const indexPath = `${root}${technical ? 'tech-search.json' : 'search.json'}`;
      const requests = [];
      const errors = [];
      let releaseIndex;
      const indexReady = new Promise((resolve) => { releaseIndex = resolve; });
      const server = http.createServer(async (req, res) => {
        requests.push(req.url);
        if (req.url === indexPath) {
          await indexReady;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(posts));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const resources = new class extends ResourceLoader {
        fetch(url) {
          if (url === `${origin}${root}js/search.js`) return Promise.resolve(library);
          if (url.includes('simple-jekyll-search')) {
            errors.push(`Duplicate search library: ${url}`);
          }
          return Promise.resolve(Buffer.from(''));
        }
      }();
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', (error) => errors.push(error.message));
      virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
      const html = ejs.render(scripts, {
        theme: { scripts: root === '/' ? [] : [`${root}js/search.js`] },
        url_for: (url) => url_for.call({ config: { root, url: `${origin}${root}` } }, url),
      });
      const dom = new JSDOM(`<input id="search-input" type="search"${technical ? ' data-search-type="tech"' : ''}><ul id="search-results"></ul>${html}`, {
        url: `${origin}${root}archives/2026/01/`,
        runScripts: 'dangerously', resources, virtualConsole,
      });
      try {
        await once(dom.window, 'load');
        const input = dom.window.document.querySelector('#search-input');
        const results = dom.window.document.querySelector('#search-results');
        function search(query) {
          input.value = query;
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
        search('启航');
        releaseIndex();
        await new Promise((resolve, reject) => {
          const observer = new dom.window.MutationObserver(() => {
            if (!results.querySelector('a')) return;
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Search did not render; index requests: ${requests.join(', ')}`));
          }, 1500);
          observer.observe(results, { childList: true, subtree: true });
        });
        assert.equal(results.querySelector('a').textContent, posts[0].title);
        assert.equal(results.querySelector('a').getAttribute('href'), posts[0].url);
        assert.equal(results.querySelector('a').title, `标签：${posts[0].tags}`);
        assert.equal(results.querySelectorAll('script').length, 0);
        search('nOvEl');
        assert.equal(results.querySelectorAll('a').length, 1);
        search('不存在的文章');
        assert.equal(results.textContent, '未找到相关文章');
        search('');
        assert.equal(results.textContent, '');
        assert.deepEqual(requests, [indexPath]);
        assert.deepEqual(errors, []);
      } finally {
        releaseIndex();
        dom.window.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});
