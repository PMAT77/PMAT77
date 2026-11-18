const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildSpeechText, htmlToSpeech, normalizeSpeech, chunkText, splitSentences,
  textHash, voiceKeyFor, mp3PathFor, entryStatus, staleSources
} = require('./clean.cjs');

test('buildSpeechText 只保留可朗读文本', () => {
  const body = [
    '## 小标题',
    '',
    '正文**加粗**，含 `行内代码`、[链接](https://example.com/a) 与图片 ![图](a.png)。',
    '',
    '```js',
    'console.log(1);',
    '```',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '😀 表情与实体 &amp; 保留标点！',
    '',
    '<!--more-->',
    '',
    '最后一段没有句号'
  ].join('\n');
  const speech = buildSpeechText({ title: '一篇随笔', body });
  assert.ok(speech.startsWith('一篇随笔。'), speech);
  assert.ok(speech.includes('小标题'));
  assert.ok(speech.includes('正文加粗'));
  assert.ok(speech.includes('行内代码'));
  assert.ok(!speech.includes('example.com'));
  assert.ok(!speech.includes('console.log'));
  assert.ok(!speech.includes('|'));
  assert.ok(!speech.includes('😀'));
  assert.ok(speech.includes('& 保留标点！'));
  assert.ok(speech.includes('最后一段没有句号。'));
});

test('无题随笔不加标题前缀，空正文返回空串', () => {
  assert.equal(buildSpeechText({ title: '', body: '正文' }), '正文。');
  assert.equal(buildSpeechText({ title: '  ', body: '' }), '');
  assert.equal(buildSpeechText({}), '');
  assert.equal(htmlToSpeech('<p>a</p><p>b</p>'), 'a。\n\nb。');
});

test('normalizeSpeech 统一空白、补句末标点、丢弃纯符号行', () => {
  assert.equal(normalizeSpeech('  a   b \n\n\n c： '), 'a b。\n\nc。');
  assert.equal(normalizeSpeech('……\n\n——'), '');
  assert.equal(normalizeSpeech('已经结束！'), '已经结束！');
});

test('chunkText 按句读切分且不超过上限', () => {
  const text = Array.from({ length: 40 }, (_, index) => `第${index}句。`).join('');
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 100, chunk);
  assert.equal(chunks.join(''), normalizeSpeech(text).replace(/\n+/g, ''));
  assert.equal(chunks.join(''), text);

  const long = '无标点'.repeat(80);
  const hard = chunkText(long, 100);
  assert.ok(hard.length >= 3);
  for (const chunk of hard) assert.ok(Array.from(chunk).length <= 100);
  assert.equal(hard.join(''), normalizeSpeech(long));

  assert.throws(() => chunkText(text, 50), /max/);
});

test('splitSentences 在句末标点后切开', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？']);
  assert.deepEqual(splitSentences('没有标点'), ['没有标点']);
});

test('哈希与音色指纹支持增量生成', () => {
  assert.equal(textHash('正文。'), textHash('  正文。  '));
  assert.notEqual(textHash('正文。'), textHash('正文！'));
  assert.notEqual(textHash('正文。', 'voice-a'), textHash('正文。', 'voice-b'));
  assert.equal(voiceKeyFor({ speed: 1, refAudio: 'a.wav' }), voiceKeyFor({ speed: 1, refAudio: 'a.wav' }));
  assert.notEqual(voiceKeyFor({ speed: 1 }), voiceKeyFor({ speed: 1.2 }));
});

test('mp3PathFor 保留目录与中文文件名，拒绝可疑路径', () => {
  assert.equal(mp3PathFor('_posts/essay/514路.md'), 'essay/514路.mp3');
  assert.equal(mp3PathFor('_posts/中文.md'), '中文.mp3');
  assert.equal(mp3PathFor('_posts\\tech\\React.md'), 'tech/React.mp3');
  assert.throws(() => mp3PathFor('source/_posts/a.md'), /unexpected post source/);
  assert.throws(() => mp3PathFor('_posts/../a.md'), /unexpected post source/);
  assert.throws(() => mp3PathFor('_posts/'), /unexpected post source/);
});

test('entryStatus 判定 new/changed/skip', () => {
  const base = { textHash: 't', file: 'a.mp3' };
  assert.equal(entryStatus({ entry: undefined, voiceKey: 'v', manifestVoiceKey: 'v' }), 'new');
  assert.equal(entryStatus({ entry: base, textHash: 't', voiceKey: 'v', manifestVoiceKey: 'v', fileExists: () => true }), 'skip');
  assert.equal(entryStatus({ entry: base, textHash: 'x', voiceKey: 'v', manifestVoiceKey: 'v', fileExists: () => true }), 'changed');
  assert.equal(entryStatus({ entry: base, textHash: 't', voiceKey: 'v2', manifestVoiceKey: 'v', fileExists: () => true }), 'changed');
  assert.equal(entryStatus({ entry: base, textHash: 't', voiceKey: 'v', manifestVoiceKey: 'v', fileExists: () => false }), 'changed');
  assert.equal(entryStatus({ entry: null, textHash: 't', voiceKey: 'v', manifestVoiceKey: '' }), 'new');
  assert.deepEqual(staleSources({ a: {}, b: {} }, new Set(['a'])), ['b']);
});
