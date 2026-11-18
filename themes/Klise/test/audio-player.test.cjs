const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const ejs = require('ejs');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const { url_for } = require('hexo-util');

const themeDir = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(themeDir, 'layout/partials/audio-player.ejs'), 'utf8');
const library = fs.readFileSync(path.join(themeDir, 'source/js/audio.js'));

const origin = 'https://example.test';

async function mount({ audio, root = '/PMAT77/' }) {
  const html = ejs.render(template, {
    audio,
    url_for: url => url_for.call({ config: { root, url: `${origin}${root}` } }, url)
  });
  // 播放器模板本身不带脚本（避免阻塞正文渲染），脚本由主题在页尾统一加载，这里手动补上。
  const page = `<!doctype html><html><body><main><h1>技术文章标题</h1>${html}` +
    `<script src="${root}js/audio.js"></script></main></body></html>`;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM(page, {
    url: `${origin}${root}2026/01/01/post/`,
    runScripts: 'dangerously',
    resources: new class extends ResourceLoader {
      fetch(url) {
        return Promise.resolve(url.endsWith('/js/audio.js') ? library : Buffer.from(''));
      }
    }(),
    virtualConsole,
    // jsdom 不实现媒体播放，按浏览器的事件顺序补上最小行为。
    beforeParse(window) {
      window.HTMLMediaElement.prototype.play = function () {
        this.playing = true;
        this.dispatchEvent(new window.Event('play'));
        return Promise.resolve();
      };
      window.HTMLMediaElement.prototype.pause = function () {
        this.playing = false;
        this.dispatchEvent(new window.Event('pause'));
      };
      Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
        get() { return !this.playing; }, configurable: true
      });
      Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
        get() { return 125; }, configurable: true
      });
      Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
        get() { return this.position || 0; },
        set(value) { this.position = value; },
        configurable: true
      });
    }
  });
  await once(dom.window, 'load');
  return { dom, errors };
}

test('播放器脚本接管原生控件并同步进度与语速', async t => {
  const { dom, errors } = await mount({ audio: { file: 'essay/with-audio.mp3', seconds: 125, bytes: 4096 } });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const section = document.querySelector('.post-audio');
  const media = section.querySelector('audio');
  const toggle = section.querySelector('.post-audio__toggle');
  const track = section.querySelector('.post-audio__track');
  const elapsed = section.querySelector('.post-audio__elapsed');
  const total = section.querySelector('.post-audio__total');
  const speed = section.querySelector('.post-audio__speed-select');

  assert.ok(section.classList.contains('is-ready'), '脚本加载后切换到自绘控件');
  assert.equal(decodeURIComponent(media.getAttribute('src')), '/PMAT77/audio/essay/with-audio.mp3');
  assert.equal(total.textContent, '2:05', '静态页面的时长来自清单');
  // 默认 1.25 倍速朗读，比模型原始语速更适合阅读长文。
  assert.equal(speed.value, '1.25');
  assert.equal(media.playbackRate, 1.25);

  // 元数据到达前进度条不可拖动，到达后按真实时长启用。
  assert.equal(track.disabled, true);
  media.dispatchEvent(new dom.window.Event('loadedmetadata'));
  assert.equal(track.disabled, false);
  assert.equal(track.max, '125');
  assert.equal(elapsed.textContent, '0:00');

  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(section.classList.contains('is-playing'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), '暂停朗读');
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(section.classList.contains('is-playing'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  // 拖动进度条写入播放位置，时间与进度变量同步更新。
  track.value = '42';
  track.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(media.currentTime, 42);
  assert.equal(elapsed.textContent, '0:42');
  assert.equal(track.style.getPropertyValue('--ap-progress'), '33.6%');

  // 语速写入播放器并持久化，下次打开播放器沿用。
  speed.value = '1.5';
  speed.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(media.playbackRate, 1.5);
  assert.equal(dom.window.localStorage.getItem('klise-audio-speed'), '1.5');

  media.dispatchEvent(new dom.window.Event('ended'));
  assert.equal(section.classList.contains('is-playing'), false);

  media.dispatchEvent(new dom.window.Event('error'));
  assert.equal(section.classList.contains('is-error'), true);
  assert.equal(total.textContent, '音频加载失败');
  assert.deepEqual(errors, []);
});

test('没有音频时模板不渲染播放器，脚本也不报错', async () => {
  const url = `${origin}/PMAT77/js/audio.js`;
  const html = ejs.render(template, { audio: null, url_for: value => url_for.call({ config: { root: '/PMAT77/' } }, value) }) + `<script src="${url}"></script>`;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: `${origin}/PMAT77/2026/01/01/post/`,
    runScripts: 'dangerously',
    resources: new class extends ResourceLoader {
      fetch(request) {
        return Promise.resolve(request.endsWith('/js/audio.js') ? library : Buffer.from(''));
      }
    }(),
    virtualConsole
  });
  await once(dom.window, 'load');
  assert.equal(dom.window.document.querySelector('.post-audio'), null);
  assert.deepEqual(errors, []);
  dom.window.close();
});
