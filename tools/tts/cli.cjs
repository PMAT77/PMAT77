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
const LEXICON_FILE = path.join(__dirname, 'lexicon.json');
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
// api_v2.py 的 get_method_names()：整数越大切得越碎，cut5 按标点+语气词分句。
const TEXT_SPLIT_METHODS = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'];
const TUNING = {
  temperature: 1, topK: 15, topP: 1, repetitionPenalty: 1.35, seed: -1,
  textSplitMethod: 'cut5', fragmentInterval: 0.3, sampleSteps: 0, cfgRate: 0
};

const DEFAULTS = {
  api: { baseUrl: 'http://127.0.0.1:9880', timeoutMs: 300000, retries: 2 },
  gptSovits: {
    dir: '', python: 'runtime/python.exe', host: '127.0.0.1', port: 9880,
    config: 'GPT_SoVITS/configs/tts_infer.yaml', startupTimeoutMs: 240000, stopOnExit: false,
    g2pwDir: 'GPT_SoVITS/text/g2pw', polyphonicFile: 'polyphonic-fix.rep'
  },
  voice: {
    name: '我的声音', refAudio: '', refAudios: [], promptText: '', promptLang: 'zh', textLang: 'zh',
    speed: 1, parallelInfer: false, batchSize: 1, gptWeights: '', sovitsWeights: '',
    tuning: { ...TUNING }
  },
  audio: { bitrateKbps: 48, maxChunkChars: 900, chunkGapMs: 250, paragraphGapMs: 400 },
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
      refAudios: process.env.TTS_REF_AUDIOS
        ? process.env.TTS_REF_AUDIOS.split(';').map(item => item.trim()).filter(Boolean)
        : undefined,
      promptText: process.env.TTS_PROMPT_TEXT,
      promptLang: process.env.TTS_PROMPT_LANG,
      textLang: process.env.TTS_TEXT_LANG,
      speed: process.env.TTS_SPEED === undefined ? undefined : Number(process.env.TTS_SPEED),
      gptWeights: process.env.TTS_GPT_WEIGHTS,
      sovitsWeights: process.env.TTS_SOVITS_WEIGHTS
    },
    audio: { paragraphGapMs: process.env.TTS_PARAGRAPH_GAP_MS === undefined ? undefined : Number(process.env.TTS_PARAGRAPH_GAP_MS) },
    ffmpeg: process.env.FFMPEG_PATH
  };
  return merge(merge(DEFAULTS, fileConfig), env);
}

// 全局文本替换表：{ "重庆": "崇庆" } 之类，用于绕开模型读错的多音字/特殊词。
function loadLexicon() {
  if (!fs.existsSync(LEXICON_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(LEXICON_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      warn('tools/tts/lexicon.json 必须是 { "原词": "替换文本" } 对象，本次忽略');
      return {};
    }
    return data;
  } catch (error) {
    warn(`tools/tts/lexicon.json 解析失败，本次忽略：${error.message}`);
    return {};
  }
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

// ffmpeg 同目录通常就有 ffprobe；找不到就算了，只做尽力而为的时长校验。
function ffprobeFor(ffmpeg) {
  const name = String(ffmpeg || 'ffmpeg');
  if (/ffmpeg(\.exe)?$/i.test(name)) {
    return name.replace(/ffmpeg(\.exe)?$/i, match => (match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
  }
  return 'ffprobe';
}

function probeAudioSeconds(file, config) {
  if (!/\.(wav|mp3|flac|ogg|m4a)$/i.test(file)) return null;
  const probe = spawnSync(ffprobeFor(config.ffmpeg), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) return null;
  const seconds = Number(String(probe.stdout).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function normalizeTuning(tuning = {}) {
  const bounded = (key, fallback, min, max, integer) => {
    const value = Number(tuning[key]);
    if (!Number.isFinite(value)) return fallback;
    const clamped = Math.min(max, Math.max(min, value));
    return integer ? Math.round(clamped) : clamped;
  };
  const method = String(tuning.textSplitMethod || TUNING.textSplitMethod);
  if (!TEXT_SPLIT_METHODS.includes(method)) {
    fail(`voice.tuning.textSplitMethod 必须是 ${TEXT_SPLIT_METHODS.join('、')} 之一`);
  }
  return {
    temperature: bounded('temperature', TUNING.temperature, 0.1, 2, false),
    topK: bounded('topK', TUNING.topK, 1, 100, true),
    topP: bounded('topP', TUNING.topP, 0.1, 1, false),
    repetitionPenalty: bounded('repetitionPenalty', TUNING.repetitionPenalty, 1, 2, false),
    seed: Number.isFinite(Number(tuning.seed)) ? Math.round(Number(tuning.seed)) : TUNING.seed,
    textSplitMethod: method,
    fragmentInterval: bounded('fragmentInterval', TUNING.fragmentInterval, 0, 2, false),
    sampleSteps: bounded('sampleSteps', TUNING.sampleSteps, 0, 64, true),
    cfgRate: bounded('cfgRate', TUNING.cfgRate, 0, 4, false)
  };
}

function validateVoice(voice, config = DEFAULTS) {
  if (!voice || typeof voice !== 'object') fail('config.json 缺少 voice 配置');
  const declared = Array.isArray(voice.refAudios) && voice.refAudios.length
    ? voice.refAudios
    : (voice.refAudio ? [voice.refAudio] : []);
  if (!declared.length) fail('config.json 里的 voice.refAudio 不能为空（3-10 秒参考音频路径）');
  voice.refAudios = declared.map(item => {
    const file = path.resolve(ROOT, String(item));
    if (!fs.existsSync(file)) fail(`参考音频不存在：${file}`);
    const seconds = probeAudioSeconds(file, config);
    if (seconds !== null && (seconds < 3 || seconds > 10)) {
      warn(`参考音频 ${path.basename(file)} 时长 ${seconds.toFixed(2)} 秒，接口要求 3～10 秒，会被拒绝`);
    }
    return file;
  });
  voice.refAudio = voice.refAudios[0];
  if (voice.refAudios.length > 3) warn('参考音频超过 3 段，生成会明显变慢，建议 1～3 段');
  if (!voice.promptText) {
    warn('voice.promptText 为空，零样本克隆效果会明显变差；建议填第一段参考音频的逐字文本');
  }
  voice.promptLang = String(voice.promptLang || 'zh');
  voice.textLang = String(voice.textLang || 'zh');
  voice.speed = Number(voice.speed) > 0 ? Number(voice.speed) : 1;
  voice.tuning = normalizeTuning({ ...(voice.tuning || {}) });
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
    const lexicon = parsed.data.audio_lexicon;
    return {
      source: `_posts/${relative}`,
      title: typeof parsed.data.title === 'string' ? parsed.data.title : '',
      body: parsed.body,
      audioEnabled: parsed.data.audio !== false,
      lexicon: lexicon && typeof lexicon === 'object' && !Array.isArray(lexicon) ? lexicon : null
    };
  });
}

function plan(config, { options, voiceKey }) {
  const manifest = readManifest();
  const globalLexicon = config.lexicon || {};
  const entries = collectPosts().map(post => {
    const record = { source: post.source, audioEnabled: post.audioEnabled, selected: !options.only || post.source.includes(options.only) };
    if (!post.audioEnabled) return record;
    const rawSpeech = clean.buildSpeechText({ title: post.title, body: post.body });
    const lexicon = { ...globalLexicon, ...(post.lexicon || {}) };
    const speechText = Object.keys(lexicon).length ? clean.applyLexicon(rawSpeech, lexicon) : rawSpeech;
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

function printPlan({ entries, pending }, speed, maxChunkChars = 900) {
  log(`干跑（--dry-run）：共 ${entries.length} 篇文章，待生成 ${pending.length} 篇`);
  for (const entry of pending) {
    const chunks = clean.chunkText(entry.speechText, Number(maxChunkChars) || 900).length;
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

// 清单里对不上任何可朗读文章的条目一律清掉：文章已删、写了 audio: false、
// 或正文短于 MIN_CHARS。这些条目留着会让主题渲染播放器，而音频可能是旧文本生成的。
function prune(manifest, { entries }) {
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

// SoVITS 微调权重的版本写在文件头两个字节：05=v2Pro、06=v2ProPlus、07=v5dev、08=v5turbo。
// tts_infer.yaml 的 custom.version 决定加载哪个网络，对不上会报张量尺寸错误或生成静音，这里提前提醒。
const SOVITS_HEAD_VERSIONS = { '05': 'v2Pro', '06': 'v2ProPlus', '07': 'v5dev', '08': 'v5turbo' };

function detectSovitsVersion(file) {
  try {
    const head = fs.readFileSync(file).subarray(0, 2).toString('latin1');
    return SOVITS_HEAD_VERSIONS[head] || null;
  } catch {
    return null;
  }
}

function inferVersion(config) {
  try {
    const yamlFile = path.resolve(path.resolve(ROOT, config.gptSovits.dir || ''), config.gptSovits.config);
    const yaml = fs.readFileSync(yamlFile, 'utf8');
    // custom 段取到下一个顶格键为止；用 (?![\s\S]) 兜住 custom 是最后一段的情况。
    const block = yaml.match(/^custom:[ \t]*\r?\n([\s\S]*?)(?=^[^\s#]|(?![\s\S]))/m);
    const match = (block ? block[1] : yaml).match(/^\s*version:\s*(\S+)/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function warnVersionMismatch(config, voice) {
  if (!voice.sovitsWeights) return;
  const weights = detectSovitsVersion(voice.sovitsWeights);
  const infer = inferVersion(config);
  if (!weights || !infer || weights === infer) return;
  warn(`SoVITS 权重是 ${weights}，但 tts_infer.yaml 的 custom 段是 ${infer}；加载后可能报张量尺寸错误或生成静音。`);
  warn('改 tts_infer.yaml 的 custom 段并重启 API；想试 v5 可以看 tools/tts/tts_infer.v5.yaml。');
}

// /tts 的请求体：tuning 里没写的参数回落到 TUNING，保证请求始终合法。
function buildPayload(voice, text) {
  const tuning = { ...TUNING, ...(voice.tuning || {}) };
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const refAudios = Array.isArray(voice.refAudios) && voice.refAudios.length ? voice.refAudios : [voice.refAudio];
  const payload = {
    text,
    text_lang: voice.textLang || 'zh',
    ref_audio_path: refAudios[0],
    aux_ref_audio_paths: refAudios.slice(1).filter(Boolean),
    prompt_lang: voice.promptLang || 'zh',
    prompt_text: voice.promptText || '',
    top_k: Math.round(num(tuning.topK, TUNING.topK)),
    top_p: num(tuning.topP, TUNING.topP),
    temperature: num(tuning.temperature, TUNING.temperature),
    text_split_method: TEXT_SPLIT_METHODS.includes(tuning.textSplitMethod) ? tuning.textSplitMethod : TUNING.textSplitMethod,
    batch_size: Number(voice.batchSize) || 1,
    batch_threshold: 0.75,
    split_bucket: true,
    speed_factor: voice.speed,
    seed: Math.round(num(tuning.seed, TUNING.seed)),
    media_type: 'wav',
    streaming_mode: false,
    parallel_infer: Boolean(voice.parallelInfer),
    repetition_penalty: num(tuning.repetitionPenalty, TUNING.repetitionPenalty),
    fragment_interval: num(tuning.fragmentInterval, TUNING.fragmentInterval)
  };
  // 这两个参数只对 v3/v5 生效，设成 0 表示交给服务端默认，不要发给接口。
  if (num(tuning.sampleSteps, 0) > 0) payload.sample_steps = Math.round(num(tuning.sampleSteps, 0));
  if (num(tuning.cfgRate, 0) > 0) payload.cfg_rate = num(tuning.cfgRate, 0);
  return payload;
}

async function requestTts(config, voice, text) {
  const payload = buildPayload(voice, text);
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

// gaps 可以是单个毫秒数，也可以是逐段毫秒数组（段落之间留长停顿）。
function concatPcm(parts, gaps = 0) {
  const first = parts[0];
  const frame = first.channels * first.bitsPerSample / 8;
  const gapMsAt = index => Math.max(0, Number(Array.isArray(gaps) ? gaps[index - 1] : gaps) || 0);
  const pieces = [];
  for (const [index, part] of parts.entries()) {
    if (part.channels !== first.channels || part.sampleRate !== first.sampleRate || part.bitsPerSample !== first.bitsPerSample) {
      throw new Error(`第 ${index + 1} 段音频格式与第一段不一致`);
    }
    if (index > 0) {
      const gap = Math.round(first.sampleRate * gapMsAt(index) / 1000) * frame;
      if (gap > 0) pieces.push(Buffer.alloc(gap));
    }
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
  const chunks = clean.chunkTextDetailed(record.speechText, Number(config.audio.maxChunkChars) || 900);
  const parts = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    log(`    第 ${chunkIndex + 1}/${chunks.length} 段（${Array.from(chunk.text).length} 字）`);
    parts.push(parseWav(await requestTts(config, voice, chunk.text)));
  }
  // 段与段之间默认短停顿；跨段落的地方用更长的停顿，听感更接近自然朗读。
  const chunkGapMs = Number(config.audio.chunkGapMs) || 0;
  const paragraphGapMs = Math.max(chunkGapMs, Number(config.audio.paragraphGapMs) || 0);
  const gaps = chunks.slice(1).map((chunk, chunkIndex) => (
    chunk.paragraph !== chunks[chunkIndex].paragraph ? paragraphGapMs : chunkGapMs
  ));
  const pcm = concatPcm(parts, gaps);
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
  config.lexicon = loadLexicon();
  const voice = config.voice;
  validateVoice(voice, config);
  warnVersionMismatch(config, voice);
  const voiceKey = clean.voiceKeyFor({ ...voice, paragraphGapMs: config.audio.paragraphGapMs });
  if (!options.dryRun) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const release = options.dryRun ? null : acquireLock();
  try {
    log(`音色：${voice.name}｜接口：${config.api.baseUrl}｜输出：source/audio`);
    log(`参数：temperature ${voice.tuning.temperature}｜top_k ${voice.tuning.topK}｜top_p ${voice.tuning.topP}｜` +
      `repetition_penalty ${voice.tuning.repetitionPenalty}｜分割 ${voice.tuning.textSplitMethod}｜` +
      `参考 ${voice.refAudios.length} 段｜段间 ${config.audio.paragraphGapMs}ms`);
    const planned = plan(config, { options, voiceKey });
    const { manifest, pending } = planned;
    if (manifest.voiceKey && manifest.voiceKey !== voiceKey) {
      warn('音色、参考音频、语速或调参参数与上次生成不同，选中文章都会重新生成');
    }
    if (options.dryRun) {
      printPlan(planned, voice.speed, config.audio.maxChunkChars);
      return 0;
    }
    const persist = () => {
      manifest.version = MANIFEST_VERSION;
      manifest.voiceKey = voiceKey;
      manifest.voice = {
        name: voice.name, speed: voice.speed, textLang: voice.textLang, promptLang: voice.promptLang,
        refAudios: voice.refAudios.map(file => path.basename(file)), tuning: voice.tuning,
        gptWeights: voice.gptWeights ? path.basename(voice.gptWeights) : '',
        sovitsWeights: voice.sovitsWeights ? path.basename(voice.sovitsWeights) : ''
      };
      manifest.generatedAt = new Date().toISOString();
      writeManifest(manifest);
    };
    // 每生成一篇就落盘，长任务中途中断也不会丢掉已完成的进度。
    if (prune(manifest, planned)) persist();
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

module.exports = {
  run,
  splitSource,
  loadConfig,
  loadLexicon,
  validateVoice,
  normalizeTuning,
  detectSovitsVersion,
  inferVersion,
  warnVersionMismatch,
  collectPosts,
  plan,
  printPlan,
  requestTts,
  buildPayload,
  parseWav,
  buildWav,
  concatPcm,
  encodeMp3,
  synthesize,
  apiReady,
  ensureServer,
  applyWeights,
  readManifest,
  writeManifest,
  checkTools,
  formatDuration,
  formatSize,
  serverCommand,
  probeAudioSeconds,
  ROOT,
  OUTPUT_DIR,
  MANIFEST_PATH,
  MIN_CHARS,
  TUNING,
  TEXT_SPLIT_METHODS
};
