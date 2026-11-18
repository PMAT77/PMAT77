const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildSpeechText, htmlToSpeech, normalizeSpeech, chunkText, chunkTextDetailed, applyLexicon,
  splitSentences, textHash, voiceKeyFor, mp3PathFor, entryStatus, staleSources
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

test('normalizeSpeech 把长破折号当成停顿改写为逗号', () => {
  assert.equal(normalizeSpeech('他说——等等——然后走了。'), '他说，等等，然后走了。');
  assert.equal(normalizeSpeech('甲————乙。'), '甲，乙。');
  // 单独的破折号整行仍会被丢掉，不会念出符号。
  assert.equal(normalizeSpeech('——'), '');
});

test('applyLexicon 按最长词优先替换，且忽略无效词条', () => {
  assert.equal(applyLexicon('重庆的火锅。', { 重庆: 'chong qing', 火: 'huo' }), 'chong qing的huo锅。');
  assert.equal(applyLexicon('原文。', {}), '原文。');
  assert.equal(applyLexicon('原文。', { a: 1, '': 'x', b: null }), '原文。');
  assert.equal(applyLexicon('', { 甲: 'yi' }), '');
});

test('chunkTextDetailed 让分块边界尽量落在段落上', () => {
  const paragraph = number => `第${number}段。`.repeat(10);
  const text = [1, 2, 3, 4].map(paragraph).join('\n\n');
  const chunks = chunkTextDetailed(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(Array.from(chunk.text).length <= 100, chunk.text);
  for (let index = 1; index < chunks.length; index++) {
    assert.notEqual(chunks[index].paragraph, chunks[index - 1].paragraph, '相邻块应来自不同段落');
  }
  assert.deepEqual(chunkText(text, 100), chunks.map(chunk => chunk.text));
  const single = chunkTextDetailed('短段落。', 100);
  assert.deepEqual(single, [{ text: '短段落。', paragraph: 1 }]);
});

test('quote 指纹包含调参、多参考与段间停顿', () => {
  const base = { refAudio: 'a.wav', tuning: { temperature: 1 } };
  assert.notEqual(
    voiceKeyFor({ ...base, tuning: { temperature: 0.6 } }),
    voiceKeyFor(base)
  );
  assert.notEqual(
    voiceKeyFor({ ...base, refAudios: ['a.wav', 'b.wav'] }),
    voiceKeyFor({ ...base, refAudios: ['b.wav', 'a.wav'] })
  );
  assert.notEqual(
    voiceKeyFor({ ...base, paragraphGapMs: 400 }),
    voiceKeyFor({ ...base, paragraphGapMs: 0 })
  );
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
