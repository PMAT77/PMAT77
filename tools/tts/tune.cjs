#!/usr/bin/env node
'use strict';

// 调参试听：用同一段文章文本，按不同的 temperature / top_p / 停顿参数各生成一小段，
// 结果落在 artifacts/tune/（不写进 public，避免试听文件随站点部署出去）。
// 只写试听产物，不改 manifest、不动正式音频。
// 用法：npm run tts:tune（或 node tools/tts/tune.cjs --serve）

const fs = require('node:fs');
const path = require('node:path');
const cli = require('./cli.cjs');
const clean = require('./clean.cjs');

const ARTIFACT_DIR = path.join(cli.ROOT, 'artifacts', 'tune');
const SAMPLE_POST = '_posts/essay/514路.md';
const DEFAULT_CHARS = 220;
const MP3_BITRATE = 96;

// 每组只改一个参数，方便听出差别；baseline 用 config.json 里的当前值。
const VARIANTS = [
  { id: 'baseline', label: '当前配置', tuning: {} },
  { id: 'temp-06', label: 'temperature 0.6（更稳，起伏更小）', tuning: { temperature: 0.6 } },
  { id: 'temp-12', label: 'temperature 1.2（起伏更大）', tuning: { temperature: 1.2 } },
  { id: 'rep-12', label: 'repetition_penalty 1.2（更松，可能复读）', tuning: { repetitionPenalty: 1.2 } },
  { id: 'rep-16', label: 'repetition_penalty 1.6（更积极打断复读）', tuning: { repetitionPenalty: 1.6 } },
  { id: 'topp-085', label: 'top_p 0.85（更保守的选词）', tuning: { topP: 0.85 } },
  { id: 'cut2', label: 'text_split_method cut2（按中文句号切）', tuning: { textSplitMethod: 'cut2' } },
  { id: 'pause-06', label: 'fragment_interval 0.6（句间停顿更长）', tuning: { fragmentInterval: 0.6 } }
];

function usage() {
  return [
    '用法：node tools/tts/tune.cjs [选项]',
    '',
    '  --serve           先拉起 GPT-SoVITS API（同 npm run tts:serve）',
    '  --chars N         试听文本长度，默认 220 字',
    '  --variant ID      只跑某一组（见下面的编号）',
    '  --dry-run         只打印计划，不调用接口',
    '  -h, --help        显示帮助',
    '',
    `可选的 --variant：${VARIANTS.map(variant => variant.id).join('、')}`
  ].join('\n');
}

function parseArgs(argv) {
  const options = { serve: false, chars: DEFAULT_CHARS, variant: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serve') options.serve = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') { console.log(usage()); process.exit(0); }
    else if (arg === '--chars') {
      const chars = Number(argv[index + 1]);
      if (!Number.isFinite(chars) || chars < 40) throw new Error('--chars 需要不小于 40 的数字');
      options.chars = Math.round(chars);
      index += 1;
    } else if (arg === '--variant') {
      options.variant = String(argv[index + 1] || '').trim();
      if (!VARIANTS.some(variant => variant.id === options.variant)) {
        throw new Error(`未知的 --variant：${options.variant}\n\n${usage()}`);
      }
      index += 1;
    } else throw new Error(`未知参数：${arg}\n\n${usage()}`);
  }
  return options;
}

function pickSample(chars) {
  const posts = cli.collectPosts().filter(post => post.audioEnabled);
  const post = posts.find(item => item.source === SAMPLE_POST)
    || posts.find(item => Array.from(clean.buildSpeechText({ title: item.title, body: item.body })).length >= chars);
  if (!post) throw new Error('找不到足够长的文章来试听，请先写一篇正文超过 200 字的文章');
  const speech = clean.buildSpeechText({ title: post.title, body: post.body });
  const characters = Array.from(speech);
  if (characters.length <= chars) return { source: post.source, text: characters.join('') };
  let cut = chars;
  while (cut > 40 && !/[。！？…]/.test(characters[cut - 1])) cut -= 1;
  return { source: post.source, text: characters.slice(0, cut).join('') };
}

function escapeHTML(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeIndex({ results, sample }) {
  const rows = results.map((result, index) => `
      <tr>
        <td>${String(index + 1).padStart(2, '0')}</td>
        <td><code>${escapeHTML(result.id)}</code><br><span class="muted">${escapeHTML(result.label)}</span></td>
        <td>${escapeHTML(result.summary)}</td>
        <td>${cli.formatDuration(result.seconds)}</td>
        <td><audio controls preload="none" src="${escapeHTML(result.file)}"></audio></td>
      </tr>`).join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>语音调参试听</title>
<style>
  body { margin: 0; padding: 28px 20px 60px; font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1c1f26; background: #fafafa; }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .muted { color: #6b7886; font-size: 13px; }
  .sample { margin: 16px 0 22px; padding: 12px 16px; border: 1px solid #ececec; border-radius: 6px; background: #fff; color: #434648; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ececec; border-radius: 6px; overflow: hidden; }
  th, td { padding: 10px 12px; border-bottom: 1px solid #f1f1f1; text-align: left; vertical-align: middle; }
  th { font-size: 13px; color: #6b7886; font-weight: 600; background: #fbfbfb; }
  audio { width: 240px; height: 34px; }
  code { background: #f6f6f6; padding: 1px 5px; border-radius: 3px; }
  @media (max-width: 720px) { table, thead, tbody, tr, td, th { display: block; } thead { display: none; } td { border: 0; padding: 4px 12px; } tr { border-bottom: 1px solid #f1f1f1; padding: 8px 0; } audio { width: 100%; } }
</style>
</head>
<body><main>
  <h1>语音调参试听</h1>
  <p class="muted">同一段文本、同一参考音频，只改一个参数。听着有改善的组合，把参数写进 <code>tools/tts/config.json</code> 的 <code>voice.tuning</code>。</p>
  <div class="sample">${escapeHTML(sample.source)}<br><span class="muted">${escapeHTML(sample.text.slice(0, 90))}…</span></div>
  <table>
    <thead><tr><th>#</th><th>参数</th><th>取值</th><th>时长</th><th>试听</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</main></body></html>
`;
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'index.html'), html);
}

function describeTuning(voice) {
  const { temperature, topK, topP, repetitionPenalty, textSplitMethod, fragmentInterval } = voice.tuning;
  return `temperature ${temperature} · top_k ${topK} · top_p ${topP} · rep ${repetitionPenalty} · ${textSplitMethod} · interval ${fragmentInterval}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = cli.loadConfig();
  const voice = config.voice;
  cli.validateVoice(voice, config);
  const sample = pickSample(options.chars);
  const selected = options.variant ? VARIANTS.filter(variant => variant.id === options.variant) : VARIANTS;

  console.log(`[tune] 音色：${voice.name}｜接口：${config.api.baseUrl}`);
  console.log(`[tune] 试听文本：${sample.source}（${Array.from(sample.text).length} 字）`);
  if (options.dryRun) {
    for (const variant of selected) {
      const tuned = cli.normalizeTuning({ ...voice.tuning, ...variant.tuning });
      console.log(`[tune]   ${variant.id.padEnd(9)} ${variant.label} → ${describeTuning({ ...voice, tuning: tuned })}`);
    }
    return 0;
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  cli.checkTools(config);
  let server = null;
  if (options.serve) server = await cli.ensureServer(config);
  if (!(await cli.apiReady(config))) {
    throw new Error(`连不上 GPT-SoVITS API（${config.api.baseUrl}）。先启动服务，或用 npm run tts:tune -- --serve`);
  }
  await cli.applyWeights(config, voice);

  const results = [];
  try {
    for (const [index, variant] of selected.entries()) {
      const tuning = cli.normalizeTuning({ ...voice.tuning, ...variant.tuning });
      const tuned = { ...voice, tuning };
      const name = `${String(index + 1).padStart(2, '0')}-${variant.id}`;
      const wavFile = path.join(ARTIFACT_DIR, `${name}.wav`);
      const mp3File = path.join(ARTIFACT_DIR, `${name}.mp3`);
      const began = Date.now();
      process.stdout.write(`[tune] ${name}：${variant.label} … `);
      const wav = cli.parseWav(await cli.requestTts(config, tuned, sample.text));
      const format = { sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: wav.bitsPerSample };
      fs.writeFileSync(wavFile, cli.buildWav(format, wav.data));
      await cli.encodeMp3(config.ffmpeg, wavFile, mp3File, MP3_BITRATE);
      const seconds = wav.data.length / (format.sampleRate * format.channels * format.bitsPerSample / 8);
      results.push({
        id: variant.id, label: variant.label, file: path.basename(mp3File), seconds,
        summary: describeTuning(tuned)
      });
      console.log(`${cli.formatDuration(seconds)}（${((Date.now() - began) / 1000).toFixed(1)}s）`);
    }
  } finally {
    if (server) await cli.stopServer(config, server);
  }

  writeIndex({ results, sample: { source: sample.source, text: sample.text } });
  console.log(`[tune] 生成 ${results.length} 组，文件在 artifacts/tune/`);
  console.log(`[tune] 试听页：${path.join(ARTIFACT_DIR, 'index.html')}（用浏览器直接打开，本地播放器即可试听）`);
  for (const result of results) console.log(`[tune]   ${result.file}  ${result.label}`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[tune] ✗ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { VARIANTS, pickSample, describeTuning, parseArgs };
