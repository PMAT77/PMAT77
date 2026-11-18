const path = require('node:path');
const { readManifest, audioFor } = require('../lib/audio.cjs');

// 排在 content.js（priority 20）之后：那时 front matter 已规整，post.source 已就绪。
// 把 tools/tts/manifest.json 里的条目挂到 post.audio，模板据此渲染播放器。
hexo.extend.filter.register('before_generate', function () {
  const posts = this.locals.get('posts').toArray();
  const audioDir = path.join(this.source_dir, 'audio');
  const manifest = readManifest(path.join(this.base_dir, 'tools', 'tts', 'manifest.json'));
  const changed = [];
  for (const post of posts) {
    if (post.audio === false) continue; // 作者在 front-matter 用 audio: false 显式关闭
    const audio = manifest ? audioFor(manifest, post, audioDir) : null;
    if (audio) {
      post.audio = audio;
      changed.push(post);
    } else if (post.audio && typeof post.audio === 'object') {
      // 音频被删除或 manifest 丢失时，清掉上一次构建留下的数据，避免渲染失效链接。
      post.audio = null;
      changed.push(post);
    }
  }
  if (!changed.length) return;
  return Promise.all(changed.map(post => post.save()));
}, 21);
