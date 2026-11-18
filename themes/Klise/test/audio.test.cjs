const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Hexo = require('hexo');
const { JSDOM } = require('jsdom');
const yaml = require('js-yaml');
const { readManifest, audioFor } = require('../lib/audio.cjs');

const themeDir = path.resolve(__dirname, '..');
const siteDir = path.resolve(themeDir, '../..');

test('audioFor 只接受安全的相对路径且要求文件存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klise-audio-lib-'));
  fs.mkdirSync(path.join(dir, 'essay'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'essay', 'a.mp3'), 'x');
  const manifest = {
    entries: {
      '_posts/a.md': { file: 'essay/a.mp3', seconds: 12.5, bytes: 3 },
      '_posts/dotdot.md': { file: '../a.mp3', seconds: 1, bytes: 1 },
      '_posts/absolute.md': { file: '/audio/a.mp3', seconds: 1, bytes: 1 },
      '_posts/windows.md': { file: 'C:/audio/a.mp3', seconds: 1, bytes: 1 },
      '_posts/missing.md': { file: 'missing.mp3', seconds: 1, bytes: 1 }
    }
  };
  assert.deepEqual(audioFor(manifest, { source: '_posts/a.md' }, dir), { file: 'essay/a.mp3', seconds: 12.5, bytes: 3 });
  for (const source of ['_posts/dotdot.md', '_posts/absolute.md', '_posts/windows.md', '_posts/missing.md', '_posts/none.md']) {
    assert.equal(audioFor(manifest, { source }, dir), null, source);
  }
  assert.equal(audioFor(null, { source: '_posts/a.md' }, dir), null);
  assert.equal(readManifest(path.join(dir, 'nope')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Hexo 只在有音频时渲染播放器', async t => {
  for (const root of ['/', '/PMAT77/']) {
    await t.test(root, async t => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'klise-audio-test-'));
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
      write('_config.yml', `title: Audio Test\nauthor: 作者\nurl: https://example.test${root}\ntheme: Klise\npermalink: ${permalink}\nindex_generator:\n  per_page: 0\nper_page: 0\nfuture: true\n`);

      const post = (name, header, body) => write(`source/_posts/${name}.md`, `---\n${header}\n---\n${body}`);
      post('with-audio', 'title: 有音频\ncontent_type: essay\ndate: 2026-01-01', '这是一篇有朗读音频的文章。');
      post('中文标题', 'title: 中文标题\ncontent_type: essay\ndate: 2026-01-02', '文件名是中文的。');
      post('without-audio', 'title: 没有音频\ncontent_type: essay\ndate: 2026-01-03', '这篇没有音频。');
      post('muted', 'title: 关闭朗读\ncontent_type: essay\ndate: 2026-01-04\naudio: false', '作者关闭了朗读。');
      post('escaper', 'title: 越界条目\ncontent_type: essay\ndate: 2026-01-05', 'manifest 路径不合法。');
      write('source/audio/essay/with-audio.mp3', 'ID3 fake mp3');
      write('source/audio/essay/中文标题.mp3', 'ID3 fake mp3');
      write('source/audio/muted.mp3', 'ID3 fake mp3');
      write('tools/tts/manifest.json', JSON.stringify({
        version: 1,
        voiceKey: 'v1',
        voice: { name: '测试音色' },
        entries: {
          '_posts/with-audio.md': { file: 'essay/with-audio.mp3', seconds: 12.5, bytes: 1024, chars: 100 },
          '_posts/中文标题.md': { file: 'essay/中文标题.mp3', seconds: 3725, bytes: 2048, chars: 1000 },
          '_posts/muted.md': { file: 'muted.mp3', seconds: 5, bytes: 512 },
          '_posts/escaper.md': { file: '../escape.mp3', seconds: 5, bytes: 512 }
        }
      }));

      const hexo = new Hexo(base, { silent: true });
      t.after(async () => {
        await hexo.exit();
        assert.equal(path.dirname(base), os.tmpdir());
        fs.rmSync(base, { recursive: true, force: true });
      });
      await hexo.init();
      await hexo.call('generate');

      const html = name => fs.readFileSync(path.join(base, 'public', name), 'utf8');
      const dom = name => new JSDOM(html(name)).window.document;
      const pageFor = source => hexo.locals.get('posts').toArray().find(post => post.source === source);
      const detail = source => dom(`${pageFor(source).path}index.html`);

      const withAudio = detail('_posts/with-audio.md');
      const player = withAudio.querySelector('.post-audio');
      assert.ok(player, '有 manifest 条目时必须渲染播放器');
      assert.equal(player.getAttribute('aria-label'), '文章朗读');
      assert.equal(decodeURIComponent(player.querySelector('.post-audio__native').getAttribute('src')),
        `${root}audio/essay/with-audio.mp3`);
      assert.equal(player.querySelector('.post-audio__total').textContent.trim(), '0:13');
      assert.equal(player.querySelector('.post-audio__toggle').getAttribute('aria-label'), '播放朗读');
      assert.equal(player.querySelector('.post-audio__toggle').getAttribute('aria-pressed'), 'false');
      assert.ok(player.querySelector('.post-audio__track').disabled, '进度条在元数据加载前应禁用');
      assert.equal(player.querySelector('.post-audio__speed-select').value, '1.25');

      // 播放器脚本只出现一次，并且排在正文之后，避免首屏被脚本阻塞。
      const detailHtml = html(`${pageFor('_posts/with-audio.md').path}index.html`);
      assert.equal((detailHtml.match(/js\/audio\.js/g) || []).length, 1, '播放器脚本只应加载一次');
      assert.ok(detailHtml.indexOf('js/audio.js') > detailHtml.indexOf('class="page-content"'),
        '播放器脚本应在正文之后加载');

      const chinese = detail('_posts/中文标题.md');
      assert.equal(decodeURIComponent(chinese.querySelector('.post-audio__native').getAttribute('src')),
        `${root}audio/essay/中文标题.mp3`);
      assert.equal(chinese.querySelector('.post-audio__total').textContent.trim(), '1:02:05', '超过一小时显示小时');

      for (const source of ['_posts/without-audio.md', '_posts/muted.md', '_posts/escaper.md']) {
        assert.equal(detail(source).querySelector('.post-audio'), null, `${source} 不应渲染播放器`);
      }
      assert.ok(detail('_posts/without-audio.md').querySelector('.page-content').textContent.includes('这篇没有音频'));

      const routes = new Set(hexo.route.list());
      assert.ok(routes.has('audio/essay/with-audio.mp3'), '音频应被复制到站点资源');
      assert.ok(routes.has('audio/essay/中文标题.mp3'));
      assert.ok(routes.has('js/audio.js'), '播放器脚本应作为主题资源产出');

      // manifest 丢失后，第二次构建必须清掉上一次注入的数据，不能渲染失效链接。
      fs.rmSync(path.join(base, 'tools/tts/manifest.json'));
      await hexo.call('generate');
      assert.equal(detail('_posts/with-audio.md').querySelector('.post-audio'), null);

      // manifest 损坏同样只按“没有音频”处理，构建不能失败。
      write('tools/tts/manifest.json', '{ 这不是 JSON');
      await hexo.call('generate');
      assert.equal(detail('_posts/with-audio.md').querySelector('.post-audio'), null);
    });
  }
});
