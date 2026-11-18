'use strict';

// 读取 tools/tts 生成的 manifest.json，把音频条目挂到文章上。
// 任何缺失/损坏都按“没有音频”处理，保证没有音频时构建照常通过。

const fs = require('node:fs');
const path = require('node:path');

function readManifest(manifestPath) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

// 只接受相对 posix 路径，拒绝绝对路径、盘符与 .. 跳出。
function safeFile(file) {
  return typeof file === 'string' && file.length > 0 && !file.startsWith('/') &&
    !file.includes('\\') && !/^[a-zA-Z]:/.test(file) &&
    !file.split('/').some(part => part === '' || part === '.' || part === '..');
}

function audioFor(manifest, post, audioDir) {
  if (!manifest || !post || typeof post.source !== 'string') return null;
  const entry = manifest.entries[post.source];
  if (!entry || typeof entry !== 'object' || !safeFile(entry.file)) return null;
  if (!fs.existsSync(path.join(audioDir, ...entry.file.split('/')))) return null;
  const seconds = Number(entry.seconds);
  const bytes = Number(entry.bytes);
  return {
    file: entry.file,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  };
}

module.exports = { readManifest, audioFor };
