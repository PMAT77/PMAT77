#!/usr/bin/env node
'use strict';

// 把 tools/tts/pronunciation.json 里的读音同步进 GPT-SoVITS 的多音字词表
// （GPT_SoVITS/text/g2pw/polyphonic-fix.rep），让 G2PW 按指定拼音读。
// 词表格式：每行 `词: ['pin1', 'yin2']`，拼音个数必须与字数一致；词表变化后需要重启 API。
// 用法：npm run tts:pronounce -- [--dry-run] [--restart]

const fs = require('node:fs');
const path = require('node:path');
const cli = require('./cli.cjs');

const PRONUNCIATION_FILE = path.join(__dirname, 'pronunciation.json');
const ENTRY_LINE = /^([^:]+):\s*(\[.*\])\s*$/;
const PINYIN = /^[a-z]+[1-5]$/i;

function usage() {
  return [
    '用法：npm run tts:pronounce -- [选项]',
    '',
    '  --dry-run   只显示将要增加/覆盖的词条，不写文件',
    '  --restart   写完后调用 /control?command=restart 重启 API（需要接口在运行）',
    '  --file X    覆盖词表路径（默认取 gptSovits.dir + g2pwDir + polyphonicFile）',
    '  -h, --help  显示本帮助',
    '',
    '词条写在 tools/tts/pronunciation.json，格式：{ "重庆": ["chong2", "qing4"] }'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dryRun: false, restart: false, file: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--restart') options.restart = true;
    else if (arg === '-h' || arg === '--help') { console.log(usage()); process.exit(0); }
    else if (arg === '--file') {
      options.file = String(argv[index + 1] || '').trim();
      if (!options.file) throw new Error('--file 需要一个词表路径');
      index += 1;
    } else throw new Error(`未知参数：${arg}\n\n${usage()}`);
  }
  return options;
}

// 现有词表是按行 `词: ['pinyin', ...]` 的 Python 字面量；这里只做单引号转双引号的 JSON 解析。
function parseRep(content) {
  const entries = new Map();
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(ENTRY_LINE);
    if (!match) continue;
    try {
      const pinyins = JSON.parse(match[2].replace(/'/g, '"'));
      if (Array.isArray(pinyins) && pinyins.length) entries.set(match[1].trim(), pinyins);
    } catch { /* 格式不认识就跳过，不阻断同步 */ }
  }
  return entries;
}

function formatEntry(word, pinyins) {
  return `${word}: [${pinyins.map(pinyin => `'${pinyin}'`).join(', ')}]`;
}

function validateEntries(entries) {
  const valid = [];
  const errors = [];
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { valid, errors: ['pronunciation.json 必须是 { "词": ["pinyin", ...] } 对象'] };
  }
  for (const [word, pinyins] of Object.entries(entries)) {
    if (typeof word !== 'string' || !word.trim()) { errors.push('出现空词条'); continue; }
    if (word.includes(':')) { errors.push(`${word}：词条里不能有冒号`); continue; }
    if (!Array.isArray(pinyins) || !pinyins.length) { errors.push(`${word}：拼音必须是数组`); continue; }
    if (pinyins.length !== Array.from(word).length) {
      errors.push(`${word}：${Array.from(word).length} 个字却写了 ${pinyins.length} 个拼音`);
      continue;
    }
    const bad = pinyins.find(pinyin => typeof pinyin !== 'string' || !PINYIN.test(pinyin));
    if (bad !== undefined) { errors.push(`${word}：拼音格式不对（${bad}），要写成 chong2 这样带声调数字的形式`); continue; }
    valid.push([word, pinyins]);
  }
  return { valid, errors };
}

// 合并：已有的词原地覆盖，新词追加到末尾；保持原有行序，diff 最小。
function mergeRep(content, entries) {
  const lines = String(content || '').split(/\r?\n/);
  const pending = new Map(entries);
  const added = [];
  const updated = [];
  const merged = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const match = trimmed.match(ENTRY_LINE);
    if (!match) return line;
    const word = match[1].trim();
    if (!pending.has(word)) return line;
    const next = pending.get(word);
    pending.delete(word);
    const previous = parseRep(trimmed).get(word);
    if (previous && previous.join(' ') === next.join(' ')) return line;
    (previous ? updated : added).push(word);
    return formatEntry(word, next);
  });
  for (const [word, pinyins] of pending) {
    added.push(word);
    merged.push(formatEntry(word, pinyins));
  }
  const text = merged.join('\n').replace(/\n{2,}/g, '\n').trim();
  return { content: `${text}\n`, added, updated };
}

async function restartApi(config) {
  if (!(await cli.apiReady(config))) return false;
  const response = await fetch(`${config.api.baseUrl}/control?command=restart`, { signal: AbortSignal.timeout(8000) });
  return response.ok;
}

function readEntries() {
  if (!fs.existsSync(PRONUNCIATION_FILE)) {
    throw new Error(`找不到 ${PRONUNCIATION_FILE}；先创建这个文件，格式：{ "重庆": ["chong2", "qing4"] }`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PRONUNCIATION_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`tools/tts/pronunciation.json 不是合法 JSON：${error.message}`);
  }
  const { valid, errors } = validateEntries(data);
  for (const message of errors) console.warn(`[pronounce] ⚠ ${message}`);
  if (!valid.length) throw new Error('pronunciation.json 里没有可用的词条');
  return valid;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = cli.loadConfig();
  const gptDir = path.resolve(cli.ROOT, config.gptSovits.dir || '');
  const dictFile = options.file
    ? path.resolve(cli.ROOT, options.file)
    : path.join(gptDir, config.gptSovits.g2pwDir, config.gptSovits.polyphonicFile);
  if (!fs.existsSync(dictFile)) {
    throw new Error(`找不到多音字词表：${dictFile}（检查 config.json 的 gptSovits.dir / g2pwDir / polyphonicFile）`);
  }
  const entries = readEntries();
  const original = fs.existsSync(dictFile) ? fs.readFileSync(dictFile, 'utf8') : '';
  const { content, added, updated } = mergeRep(original, entries);

  console.log(`[pronounce] 词表：${dictFile}`);
  console.log(`[pronounce] 新增 ${added.length} 条，覆盖 ${updated.length} 条${added.length ? `：${added.join('、')}` : ''}`);
  for (const word of updated) console.log(`[pronounce]   覆盖 ${word} → ${entries.find(([entry]) => entry === word)[1].join(' ')}`);
  if (options.dryRun) {
    console.log('[pronounce] 干跑：不写文件');
    return 0;
  }

  const backup = `${dictFile}.bak`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(dictFile, backup);
    console.log(`[pronounce] 已备份原始词表：${path.basename(backup)}`);
  }
  fs.writeFileSync(dictFile, content, 'utf8');
  // 删掉缓存与校验文件，让 g2pw 下次启动时按新词表重建。
  for (const cache of ['polyphonic.md5', 'polyphonic.pickle']) {
    fs.rmSync(path.join(path.dirname(dictFile), cache), { force: true });
  }
  console.log('[pronounce] 词表已写入，缓存已清除');
  if (options.restart) {
    const restarted = await restartApi(config);
    console.log(restarted
      ? '[pronounce] 已请求 API 重启，等几秒后生效'
      : '[pronounce] API 没在运行，下次启动时生效');
  } else {
    console.log('[pronounce] 重启 API 后生效：npm run tts:serve（或 curl http://127.0.0.1:9880/control?command=restart）');
  }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[pronounce] ✗ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseRep, formatEntry, validateEntries, mergeRep };
