#!/usr/bin/env node
'use strict';

// 离线语音生成：扫描 source/_posts 下的文章，清洗成朗读文本，调用本机 GPT-SoVITS
// 零样本克隆出 WAV，整篇拼接后用 ffmpeg 转 MP3，写入 source/audio，并在本目录写 manifest.json。
// 用法、部署注意与排障见 tools/tts/README.md。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const frontMatter = require('hexo-front-matter');
const clean = require('./clean.cjs');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOCK_FILE = path.join(__dirname, '.lock');
const POSTS_DIR = path.join(ROOT, 'source', '_posts');
const OUTPUT_DIR = path.join(ROOT, 'source', 'audio');
// 清单放在工具目录而不是 source/：Hexo 会把 source 里的 .json 交给 JSON renderer，
// 清单损坏或临时写入一半都会直接让构建报错，而这份清单只在构建期被主题脚本读取。
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_PATH = path.join(__dirname, MANIFEST_FILE);
const MANIFEST_VERSION = 1;
const MIN_CHARS = 60;
const CHARS_PER_SECOND = 4.5;

const DEFAULTS = {
  api: { baseUrl: 'http://127.0.0.1:9880', timeoutMs: 300000, retries: 2 },
  gptSovits: {
    dir: '', python: 'runtime/python.exe', host: '127.0.0.1', port: 9880,
    config: 'GPT_SoVITS/configs/tts_infer.yaml', startupTimeoutMs: 240000, stopOnExit: false
  },
  voice: {
    name: '我的声音', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh',
    speed: 1, parallelInfer: false, batchSize: 1, gptWeights: '', sovitsWeights: ''
  },
  audio: { bitrateKbps: 48, maxChunkChars: 900, chunkGapMs: 250 },
  ffmpeg: 'ffmpeg'
};

class FatalError extends Error {}

const log = (message = '') => console.log(`[tts] ${message}`);
const warn = (message = '') => console.warn(`[tts] ⚠ ${message}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new FatalError(message); };

function usage() {
  return [
    '用法：npm run tts -- [选项]',
    '',
    '  --serve     先拉起 GPT-SoVITS API（需要配置 gptSovits.dir）',
    '  --force     全部重新生成，并清理已删除文章/关闭朗读留下的过期音频',
    '  --only X    只处理 source 含子串 X 的文章（调试音色用）',
    '  --dry-run   只打印生成计划，不启动服务、不调用接口',
    '  -h, --help  显示本帮助',
    '',
    '配置：tools/tts/config.json（从 config.example.json 复制修改；该文件已被 git 忽略）'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { serve: false, force: false, only: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serve') options.serve = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') { console.log(usage()); process.exit(0); }
    else if (arg === '--only') {
      options.only = String(argv[index + 1] || '').trim();
      index += 1;
      if (!options.only) fail('--only 需要一个用于匹配 source 的子串');
    } else fail(`未知参数：${arg}\n\n${usage()}`);
  }
  return options;
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const previous = base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? base[key] : {};
      result[key] = merge(previous, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (error) {
      fail(`tools/tts/config.json 不是合法 JSON：${error.message}`);
    }
  }
  const env = {
    api: { baseUrl: process.env.TTS_BASE_URL },
    gptSovits: { dir: process.env.GPT_SOVITS_DIR },
    voice: {
      refAudio: process.env.TTS_REF_AUDIO,
      promptText: process.env.TTS_PROMPT_TEXT,
      promptLang: process.env.TTS_PROMPT_LANG,
      textLang: process.env.TTS_TEXT_LANG,
      speed: process.env.TTS_SPEED === undefined ? undefined : Number(process.env.TTS_SPEED),
      gptWeights: process.env.TTS_GPT_WEIGHTS,
      sovitsWeights: process.env.TTS_SOVITS_WEIGHTS
    },
    ffmpeg: process.env.FFMPEG_PATH
  };
  return merge(merge(DEFAULTS, fileConfig), env);
}

function serverCommand(config) {
  const dir = config.gptSovits.dir || '<GPT-SoVITS 目录>';
  return `python api_v2.py -a ${config.gptSovits.host} -p ${config.gptSovits.port} -c ${config.gptSovits.config}（工作目录：${dir}）`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function readManifest() {
  const file = MANIFEST_PATH;
  const empty = { version: MANIFEST_VERSION, voiceKey: '', voice: {}, entries: {}, generatedAt: '' };
  if (!fs.existsSync(file)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...data,
      entries: data && typeof data.entries === 'object' && data.entries ? data.entries : {}
    };
  } catch (error) {
    warn(`${MANIFEST_FILE} 无法解析，按空清单重新生成：${error.message}`);
    return empty;
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  const file = MANIFEST_PATH;
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function acquireLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      fail(`另一个生成任务正在运行（确认没有后删除 ${LOCK_FILE} 再重试）`);
    }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(LOCK_FILE); } catch { /* 已删除 */ }
  };
  const onSignal = signal => {
    release();
    warn(`收到 ${signal}，提前退出；已完成的音频和清单会保留，重跑时接着做`);
    process.exit(130);
  };
  process.once('exit', release);
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  return release;
}

function validateVoice(voice) {
  if (!voice || typeof voice !== 'object') fail('config.json 缺少 voice 配置');
  if (!voice.refAudio) fail('config.json 里的 voice.refAudio 不能为空（3-10 秒参考音频路径）');
  const refAudio = path.resolve(ROOT, String(voice.refAudio));
  if (!fs.existsSync(refAudio)) fail(`参考音频不存在：${refAudio}`);
  if (!voice.promptText) {
    warn('voice.promptText 为空，零样本克隆效果会明显变差；建议填参考音频的逐字文本');
  }
  voice.refAudio = refAudio;
  voice.speed = Number(voice.speed) > 0 ? Number(voice.speed) : 1;
  for (const [label, key] of [['GPT', 'gptWeights'], ['SoVITS', 'sovitsWeights']]) {
    if (!voice[key]) continue;
    const weights = path.resolve(ROOT, String(voice[key]));
    if (!fs.existsSync(weights)) fail(`${label} 微调权重不存在：${weights}`);
    voice[key] = weights;
  }
}

function checkTools(config) {
  const probe = spawnSync(config.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    fail([
      `找不到可用的 ffmpeg（配置值：${config.ffmpeg}）。`,
      '安装：winget install Gyan.FFmpeg；或把 tools/tts/config.json 的 ffmpeg 指向 GPT-SoVITS 目录下的 ffmpeg.exe。'
    ].join('\n'));
  }
}

function listPostFiles(dir) {
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(target);
    }
  };
  walk(dir);
  return files.sort();
}

// Windows 上写的文章常见 CRLF，hexo-front-matter 只认 LF：先统一换行再解析。
// 单篇文章头部写坏时不让整批生成失败，退化成「按分隔线剥掉开头」。
function splitSource(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let data;
  try {
    data = frontMatter.parse(text);
  } catch {
    data = {};
  }
  let body = typeof data._content === 'string' ? data._content : text;
  const fence = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!data.content_type && !data.title && fence && /^[A-Za-z_][\w-]*\s*:/m.test(fence[1])) {
    body = body.slice(fence[0].length);
  }
  return { data, body };
}

function collectPosts() {
  if (!fs.existsSync(POSTS_DIR)) fail(`找不到文章目录：${POSTS_DIR}`);
  return listPostFiles(POSTS_DIR).map(file => {
    let parsed;
    try {
      parsed = splitSource(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      fail(`${path.relative(ROOT, file)} 的 front-matter 解析失败：${error.message}`);
    }
    const relative = path.relative(POSTS_DIR, file).split(path.sep).join('/');
    return {
      source: `_posts/${relative}`,
      title: typeof parsed.data.title === 'string' ? parsed.data.title : '',
      body: parsed.body,
      audioEnabled: parsed.data.audio !== false
    };
  });
}

function plan(config, { options, voiceKey }) {
  const manifest = readManifest();
  const entries = collectPosts().map(post => {
    const record = { source: post.source, audioEnabled: post.audioEnabled, selected: !options.only || post.source.includes(options.only) };
    if (!post.audioEnabled) return record;
    const speechText = clean.buildSpeechText({ title: post.title, body: post.body });
    record.chars = Array.from(speechText).length;
    if (record.chars < MIN_CHARS) {
      record.problem = `正文只有 ${record.chars} 字，跳过`;
      return record;
    }
    record.speechText = speechText;
    record.file = clean.mp3PathFor(post.source);
    record.target = path.join(OUTPUT_DIR, ...record.file.split('/'));
    record.textHash = clean.textHash(speechText, voiceKey);
    // --force 表示不信任现有产物：正文没变也重做，便于换音色做对比试听。
    record.status = options.force ? 'changed' : clean.entryStatus({
      entry: manifest.entries[post.source],
      textHash: record.textHash,
      voiceKey,
      manifestVoiceKey: manifest.voiceKey,
      fileExists: file => Boolean(file) && fs.existsSync(path.join(OUTPUT_DIR, ...String(file).split('/')))
    });
    return record;
  });
  const pending = entries.filter(entry => entry.selected && entry.audioEnabled && !entry.problem && entry.status !== 'skip');
  return { manifest, entries, pending };
}

function estimate(record, speed) {
  return record.chars / CHARS_PER_SECOND / speed;
}

function printPlan({ entries, pending }, speed) {
  log(`干跑（--dry-run）：共 ${entries.length} 篇文章，待生成 ${pending.length} 篇`);
  for (const entry of pending) {
    const chunks = clean.chunkText(entry.speechText, 900).length;
    log(`  ${entry.status === 'new' ? '新建  ' : '更新  '} ${entry.source}`);
    log(`        ${entry.chars} 字 · ${chunks} 段 · 约 ${formatDuration(estimate(entry, speed))} · → ${entry.file}`);
  }
  const skipped = entries.filter(entry => entry.status === 'skip').length;
  const disabled = entries.filter(entry => !entry.audioEnabled).length;
  const short = entries.filter(entry => entry.problem).length;
  log(`  已有音频 ${skipped} 篇，audio:false ${disabled} 篇，正文过短 ${short} 篇`);
  const seconds = pending.reduce((sum, entry) => sum + estimate(entry, speed), 0);
  log(`  预计音频总长 ${formatDuration(seconds)}`);
}

function prune(manifest, { entries }, options) {
  if (options.only) return false;
  const wanted = new Set(entries.filter(entry => entry.audioEnabled && !entry.problem).map(entry => entry.source));
  let changed = false;
  for (const source of clean.staleSources(manifest.entries, wanted)) {
    const file = manifest.entries[source] && manifest.entries[source].file;
    if (file) fs.rmSync(path.join(OUTPUT_DIR, ...String(file).split('/')), { force: true });
    delete manifest.entries[source];
    changed = true;
    log(`清理过期音频：${source}`);
  }
  return changed;
}

async function apiReady(config) {
  try {
    const response = await fetch(`${config.api.baseUrl}/docs`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer(config) {
  if (await apiReady(config)) {
    log('检测到已在运行的 GPT-SoVITS API，直接复用');
    return null;
  }
  if (!config.gptSovits.dir) fail('--serve 需要先在 tools/tts/config.json 里配置 gptSovits.dir');
  const dir = path.resolve(ROOT, config.gptSovits.dir);
  if (!fs.existsSync(dir)) fail(`gptSovits.dir 不存在：${dir}`);
  const python = path.resolve(dir, config.gptSovits.python);
  if (!fs.existsSync(python)) fail(`找不到 GPT-SoVITS 的 Python：${python}（可在 gptSovits.python 指定，例如 runtime/python.exe）`);
  const args = ['api_v2.py', '-a', config.gptSovits.host, '-p', String(config.gptSovits.port), '-c', config.gptSovits.config];
  log(`启动 GPT-SoVITS API：${python} ${args.join(' ')}`);
  const child = spawn(python, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => process.stderr.write(`[gpt-sovits] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[gpt-sovits] ${chunk}`));
  child.on('exit', code => warn(`GPT-SoVITS API 进程退出（exit ${code}）`));
  const deadline = Date.now() + config.gptSovits.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await apiReady(config)) {
      log('GPT-SoVITS API 已就绪');
      return child;
    }
    if (child.exitCode !== null) break;
    await delay(3000);
  }
  try { child.kill(); } catch { /* 已退出 */ }
  fail(`等待 GPT-SoVITS API 启动超时（${Math.round(config.gptSovits.startupTimeoutMs / 1000)} 秒），请查看上面的 [gpt-sovits] 日志`);
}

async function stopServer(config, child) {
  if (!child) return;
  if (!config.gptSovits.stopOnExit) {
    log('GPT-SoVITS API 保持运行（gptSovits.stopOnExit 为 false）');
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    } catch { /* 忽略 */ }
    return;
  }
  try {
    await fetch(`${config.api.baseUrl}/control?command=exit`, { signal: AbortSignal.timeout(5000) });
  } catch { /* 服务可能已退出 */ }
  await delay(1500);
  if (child.exitCode === null) {
    try { child.kill(); } catch { /* 已退出 */ }
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
  }
  log('GPT-SoVITS API 已停止');
}

function describeError(buffer) {
  const text = buffer.toString('utf8').trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const message = data.detail || data.message || data.error;
    if (typeof message === 'string') return message;
    if (message) return JSON.stringify(message).slice(0, 300);
  } catch { /* 不是 JSON */ }
  return text.slice(0, 300);
}

// 微调权重通过接口热切换：api_v2.py 的 /set_gpt_weights 与 /set_sovits_weights。
// 传绝对路径，避免受服务进程工作目录影响。
async function applyWeights(config, voice) {
  const targets = [
    ['GPT', 'gptWeights', '/set_gpt_weights'],
    ['SoVITS', 'sovitsWeights', '/set_sovits_weights']
  ].filter(([, key]) => voice[key]);
  for (const [label, key, endpoint] of targets) {
    const file = voice[key];
    log(`加载 ${label} 微调权重：${path.basename(file)}`);
    let response;
    try {
      response = await fetch(`${config.api.baseUrl}${endpoint}?weights_path=${encodeURIComponent(file)}`, {
        signal: AbortSignal.timeout(Number(config.api.timeoutMs) || 300000)
      });
    } catch (error) {
      fail(`加载 ${label} 权重失败：连不上语音接口（${error.message}）`);
    }
    const body = await response.text();
    if (!response.ok) {
      fail(`加载 ${label} 权重失败：${describeError(Buffer.from(body)) || body.slice(0, 300)}`);
    }
    log(`  ✓ 已加载 ${path.basename(file)}`);
  }
}

async function requestTts(config, voice, text) {
  const payload = {
    text,
    text_lang: voice.textLang,
    ref_audio_path: voice.refAudio,
    aux_ref_audio_paths: [],
    prompt_lang: voice.promptLang,
    prompt_text: voice.promptText,
    top_k: 15,
    top_p: 1,
    temperature: 1,
    text_split_method: 'cut5',
    batch_size: Number(voice.batchSize) || 1,
    batch_threshold: 0.75,
    split_bucket: true,
    speed_factor: voice.speed,
    seed: -1,
    media_type: 'wav',
    streaming_mode: false,
    parallel_infer: Boolean(voice.parallelInfer),
    repetition_penalty: 1.35
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${config.api.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Number(config.api.timeoutMs) || 300000)
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (response.ok) {
        if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
          throw new FatalError(`语音接口返回的不是 WAV 数据：${describeError(buffer)}`);
        }
        return buffer;
      }
      const message = describeError(buffer) || '无错误详情';
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const hint = /out of memory|CUDA/i.test(message)
          ? '（显存不足：关掉其他占用显卡的程序，或保持 parallel_infer=false、调低 batch_size）'
          : '';
        throw new FatalError(`语音接口拒绝请求（HTTP ${response.status}）：${message}${hint}`);
      }
      throw new Error(`HTTP ${response.status}：${message}`);
    } catch (error) {
      if (error instanceof FatalError) throw error;
      if (attempt >= Number(config.api.retries || 0)) {
        throw new Error(`${error.message}（已重试 ${attempt} 次）`);
      }
      warn(`请求失败，${2 * (attempt + 1)} 秒后重试：${error.message}`);
      await delay(2000 * (attempt + 1));
    }
  }
}

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('语音接口返回的数据不是 WAV');
  }
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      format = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, Math.min(start + size, buffer.length));
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data || !data.length) throw new Error('WAV 缺少 fmt/data 段');
  return { ...format, data };
}

function buildWav({ sampleRate, channels, bitsPerSample }, pcm) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * bitsPerSample / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function concatPcm(parts, gapMs) {
  const first = parts[0];
  const frame = first.channels * first.bitsPerSample / 8;
  const gap = Math.round(first.sampleRate * gapMs / 1000) * frame;
  const pieces = [];
  for (const [index, part] of parts.entries()) {
    if (part.channels !== first.channels || part.sampleRate !== first.sampleRate || part.bitsPerSample !== first.bitsPerSample) {
      throw new Error(`第 ${index + 1} 段音频格式与第一段不一致`);
    }
    if (index > 0 && gap > 0) pieces.push(Buffer.alloc(gap));
    const usable = part.data.length - (part.data.length % frame);
    pieces.push(part.data.subarray(0, usable));
  }
  return Buffer.concat(pieces);
}

function encodeMp3(ffmpeg, wavFile, mp3File, bitrateKbps) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-i', wavFile, '-vn', '-ac', '1',
      '-b:a', `${Number(bitrateKbps) || 48}k`, mp3File], { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new Error(`ffmpeg 无法启动：${error.message}`)));
    child.on('close', code => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg 转码失败（exit ${code}）：${stderr.trim().slice(-500)}`))));
  });
}

async function synthesize(config, voice, record, tempDir, index) {
  const chunks = clean.chunkText(record.speechText, Number(config.audio.maxChunkChars) || 900);
  const parts = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    log(`    第 ${chunkIndex + 1}/${chunks.length} 段（${Array.from(chunk).length} 字）`);
    parts.push(parseWav(await requestTts(config, voice, chunk)));
  }
  const pcm = concatPcm(parts, Number(config.audio.chunkGapMs) || 0);
  const format = { sampleRate: parts[0].sampleRate, channels: parts[0].channels, bitsPerSample: parts[0].bitsPerSample };
  const wavFile = path.join(tempDir, `${index}.wav`);
  fs.writeFileSync(wavFile, buildWav(format, pcm));
  fs.mkdirSync(path.dirname(record.target), { recursive: true });
  await encodeMp3(config.ffmpeg, wavFile, record.target, config.audio.bitrateKbps);
  fs.rmSync(wavFile, { force: true });
  const bytesPerSecond = format.sampleRate * format.channels * format.bitsPerSample / 8;
  return {
    file: record.file,
    textHash: record.textHash,
    chars: record.chars,
    seconds: Math.round((pcm.length / bytesPerSecond) * 100) / 100,
    bytes: fs.statSync(record.target).size,
    generatedAt: new Date().toISOString()
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const voice = config.voice;
  validateVoice(voice);
  const voiceKey = clean.voiceKeyFor(voice);
  if (!options.dryRun) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const release = options.dryRun ? null : acquireLock();
  try {
    log(`音色：${voice.name}｜接口：${config.api.baseUrl}｜输出：source/audio`);
    const planned = plan(config, { options, voiceKey });
    const { manifest, pending } = planned;
    if (manifest.voiceKey && manifest.voiceKey !== voiceKey) {
      warn('音色、参考音频或语速与上次生成不同，选中文章都会重新生成');
    }
    if (options.dryRun) {
      printPlan(planned, voice.speed);
      return 0;
    }
    const persist = () => {
      manifest.version = MANIFEST_VERSION;
      manifest.voiceKey = voiceKey;
      manifest.voice = { name: voice.name, speed: voice.speed, textLang: voice.textLang, promptLang: voice.promptLang };
      manifest.generatedAt = new Date().toISOString();
      writeManifest(manifest);
    };
    // 每生成一篇就落盘，长任务中途中断也不会丢掉已完成的进度。
    if (options.force && prune(manifest, planned, options)) persist();
    if (!pending.length) {
      log(`没有需要生成的音频（共 ${planned.entries.length} 篇，已是最新）`);
      return 0;
    }
    checkTools(config);
    log(`待生成 ${pending.length} 篇，预计音频总长 ${formatDuration(pending.reduce((sum, entry) => sum + estimate(entry, voice.speed), 0))}`);
    let server = null;
    if (options.serve) server = await ensureServer(config);
    if (!(await apiReady(config))) {
      fail(`连不上 GPT-SoVITS API（${config.api.baseUrl}）。先启动服务：\n    ${serverCommand(config)}\n  或使用 npm run tts:serve`);
    }
    await applyWeights(config, voice);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paolos-tts-'));
    const started = Date.now();
    const failures = [];
    let completed = 0;
    try {
      for (const record of pending) {
        const began = Date.now();
        log(`▶ ${record.source}（${record.chars} 字，${record.status === 'new' ? '新建' : '重新生成'}）`);
        try {
          const entry = await synthesize(config, voice, record, tempDir, completed);
          manifest.entries[record.source] = entry;
          completed += 1;
          log(`  ✓ ${entry.file}  ${formatDuration(entry.seconds)}  ${formatSize(entry.bytes)}  用时 ${((Date.now() - began) / 1000).toFixed(1)}s`);
          persist();
        } catch (error) {
          failures.push({ source: record.source, message: error.message });
          warn(`  ✗ ${record.source}：${error.message}`);
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (server) await stopServer(config, server);
    }
    persist();
    log(`完成：生成 ${completed} 篇，失败 ${failures.length} 篇，已有音频 ${Object.keys(manifest.entries).length} 篇，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const failure of failures) warn(`  ${failure.source}: ${failure.message}`);
    if (failures.length) return 1;
    log('下一步：npm test && npm run build，然后检查站点里的播放器');
    return 0;
  } finally {
    if (release) release();
  }
}

if (require.main === module) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    if (error instanceof FatalError) {
      console.error(`[tts] ✗ ${error.message}`);
    } else {
      console.error('[tts] ✗ 未预期的错误：', error);
    }
    process.exitCode = 1;
  });
}

module.exports = { run, splitSource };
