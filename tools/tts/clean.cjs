'use strict';

// 正文 → 朗读文本的纯函数集合，供 tools/tts/cli.cjs 与单元测试使用。
// 原则：只保留能被中文/英文 TTS 自然读出的字符与句读；代码块、表格、图片、链接、emoji 一律丢弃。

const crypto = require('node:crypto');
const { marked } = require('marked');
const { unescapeHTML } = require('hexo-util');

// 整块丢弃的元素（内容对朗读没有意义）。
const DROP_BLOCKS = /<(script|style|pre|table|figure|svg|noscript|iframe|video|audio|math)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BREAK = /<br\s*\/?>/gi;
// 行内标签直接删掉，避免在中文词中间插入空格。
const INLINE_TAGS = /<\/?(?:a|span|em|strong|b|i|u|s|del|ins|mark|small|sup|sub|code|kbd|abbr|time|ruby|rt|rp|wbr|img)\b[^>]*>/gi;
const BLOCK_END = /<\/(?:p|div|section|article|header|footer|blockquote|li|ul|ol|dl|dt|dd|h[1-6]|details|summary|figcaption|tr|th|td|hr)>/gi;
const TAGS = /<[^>]+>/g;
const URLS = /https?:\/\/[^\s，。！？；：、）】」』"'<>]+/gi;
// 允许的字符：制表/换行、ASCII 可打印、Latin-1、CJK 标点与全角符号、中日韩统一表意文字（含扩展 A/B）。
const ALLOWED = /[^\t\n\r\u0020-\u007E\u00A0-\u00FF\u2010-\u203E\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2A6DF}]/gu;
const WORD_CHAR = /[0-9A-Za-z\u00C0-\u00FF\u3400-\u4DBF\u4E00-\u9FFF\u{20000}-\u{2A6DF}]/u;
const SENTENCE_END = /[。！？!?…]$/;
const TRAILING_NOISE = /[：:，,；;、\s]+$/;
const SPACE_BEFORE_PUNCT = /\s+([，。！？；：、…）】」』》])/g;
// 长破折号（——／――）在朗读里等于一次换气的停顿，统一成逗号，避免模型逐字拖长音。
const LONG_DASH = /—{2,}|―{2,}|–{2,}/g;
const SENTENCE_BREAK = new Set(['。', '！', '？', '…', '；', '!', '?', ';']);

function tidyLine(line) {
  const text = String(line)
    .replace(URLS, ' ')
    .replace(ALLOWED, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(LONG_DASH, '，')
    .replace(SPACE_BEFORE_PUNCT, '$1')
    .trim()
    .replace(TRAILING_NOISE, '');
  if (!text || !WORD_CHAR.test(text)) return '';
  return SENTENCE_END.test(text) ? text : `${text}。`;
}

function htmlToSpeech(html = '') {
  const plain = unescapeHTML(String(html)
    .replace(DROP_BLOCKS, '\n')
    .replace(COMMENTS, '\n')
    .replace(BREAK, '\n')
    .replace(INLINE_TAGS, '')
    .replace(BLOCK_END, '\n')
    .replace(TAGS, ' '));
  return plain.split(/\n+/).map(tidyLine).filter(Boolean).join('\n\n');
}

function normalizeSpeech(text = '') {
  return String(text).split(/\n+/).map(tidyLine).filter(Boolean).join('\n\n');
}

function buildSpeechText({ title = '', body = '' } = {}) {
  const html = marked.parse(String(body || ''), { gfm: true, headerIds: false, mangle: false });
  const speech = htmlToSpeech(html);
  const heading = tidyLine(unescapeHTML(String(title || '')).replace(TAGS, ' '));
  if (!heading) return speech;
  return speech ? `${heading}\n\n${speech}` : heading;
}

function splitSentences(paragraph) {
  const sentences = [];
  let buffer = '';
  for (const char of paragraph) {
    buffer += char;
    if (SENTENCE_BREAK.has(char)) {
      sentences.push(buffer);
      buffer = '';
    }
  }
  if (buffer.trim()) sentences.push(buffer);
  return sentences.map(sentence => sentence.trim()).filter(Boolean);
}

function hardSplit(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return [text];
  const parts = [];
  for (let index = 0; index < chars.length; index += max) {
    parts.push(chars.slice(index, index + max).join(''));
  }
  return parts;
}

// 按句读累加，单块不超过 max 个字符；超长无标点句按 max 硬切。
// 返回每块所在的段落序号：跨段落处要插更长的停顿，段落被硬切开的接缝只留短停顿。
// 攒到 max 的 60% 后遇到新段落就先收尾，让分块边界尽量落在段落上，朗读时才有段间停顿。
const PARAGRAPH_FLUSH_RATIO = 0.6;

function chunkTextDetailed(text, max = 900) {
  if (!Number.isInteger(max) || max < 100) throw new Error('max 需要是不小于 100 的整数');
  const chunks = [];
  let buffer = '';
  let bufferChars = 0;
  let bufferParagraph = 0;
  const flush = () => {
    if (buffer.trim()) chunks.push({ text: buffer.trim(), paragraph: bufferParagraph });
    buffer = '';
    bufferChars = 0;
  };
  let paragraph = 0;
  for (const line of normalizeSpeech(text).split(/\n+/)) {
    paragraph += 1;
    for (const sentence of splitSentences(line)) {
      for (const piece of hardSplit(sentence, max)) {
        const size = Array.from(piece).length;
        const boundary = bufferChars > 0 && bufferParagraph !== paragraph;
        if (bufferChars > 0 && (bufferChars + size > max || (boundary && bufferChars >= max * PARAGRAPH_FLUSH_RATIO))) flush();
        if (bufferChars === 0) bufferParagraph = paragraph;
        buffer += piece;
        bufferChars += size;
      }
    }
  }
  flush();
  return chunks;
}

function chunkText(text, max = 900) {
  return chunkTextDetailed(text, max).map(chunk => chunk.text);
}

// 文本层多音字/词替换：长词优先，避免“重庆”先被“重”拆掉。
// 只做同长度或任意长度的字符串替换，读法由用户写的替换文本决定。
function applyLexicon(text, lexicon = {}) {
  const entries = Object.entries(lexicon && typeof lexicon === 'object' ? lexicon : {})
    .filter(([from, to]) => typeof from === 'string' && from && typeof to === 'string' && to)
    .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);
  let result = String(text || '');
  for (const [from, to] of entries) result = result.split(from).join(to);
  return result;
}

function textHash(text, voiceKey = '') {
  return crypto.createHash('sha1').update(`${voiceKey}\n${normalizeSpeech(text)}`).digest('hex');
}

function voiceKeyFor(voice = {}) {
  return crypto.createHash('sha1').update(JSON.stringify({
    name: voice.name || '',
    refAudio: voice.refAudio || '',
    refAudios: Array.isArray(voice.refAudios) ? voice.refAudios : [],
    promptText: voice.promptText || '',
    promptLang: voice.promptLang || '',
    textLang: voice.textLang || '',
    speed: Number(voice.speed) || 1,
    gptWeights: voice.gptWeights || '',
    sovitsWeights: voice.sovitsWeights || '',
    tuning: voice.tuning || {},
    paragraphGapMs: Number(voice.paragraphGapMs) || 0
  })).digest('hex');
}

// _posts/essay/514路.md → essay/514路.mp3
function mp3PathFor(source) {
  const normalized = String(source || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('_posts/')) throw new Error(`unexpected post source: ${source}`);
  const relative = normalized.slice('_posts/'.length).replace(/\.md$/i, '');
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`unexpected post source: ${source}`);
  }
  return `${relative}.mp3`;
}

function entryStatus({ entry, textHash: hash, voiceKey, manifestVoiceKey, fileExists = () => true } = {}) {
  if (manifestVoiceKey && voiceKey && manifestVoiceKey !== voiceKey) return 'changed';
  if (!entry) return 'new';
  if (entry.textHash !== hash) return 'changed';
  if (!fileExists(entry.file)) return 'changed';
  return 'skip';
}

// manifest 里存在、但已没有对应文章（或文章关闭了朗读）的 source 列表。
function staleSources(entries = {}, wanted = new Set()) {
  return Object.keys(entries || {}).filter(source => !wanted.has(source));
}

module.exports = {
  buildSpeechText,
  htmlToSpeech,
  normalizeSpeech,
  tidyLine,
  splitSentences,
  hardSplit,
  chunkText,
  chunkTextDetailed,
  applyLexicon,
  textHash,
  voiceKeyFor,
  mp3PathFor,
  entryStatus,
  staleSources
};
