'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitSource, buildPayload, normalizeTuning, concatPcm, detectSovitsVersion, inferVersion } = require('./cli.cjs');

test('splitSource 解析普通 LF 的 front-matter', () => {
  const { data, body } = splitSource('---\ntitle: 测试\ncontent_type: tech\n---\n第一段。');
  assert.equal(data.title, '测试');
  assert.equal(data.content_type, 'tech');
  assert.equal(body, '第一段。');
});

test('splitSource 能处理 Windows 常见的 CRLF front-matter', () => {
  // 这就是 14 篇文章被读出标签行的原因：hexo-front-matter 只认 LF。
  const raw = '---\r\ncontent_type: essay \r\ndate: 2025-06-09 21:37:10\r\ntags: 随笔\r\n---\r\n那不过是……';
  const { data, body } = splitSource(raw);
  assert.equal(data.content_type, 'essay');
  assert.equal(data.tags, '随笔');
  assert.equal(body, '那不过是……', '正文不能混进 content_type、date、tags');
});

test('splitSource 去掉 UTF-8 BOM 后再解析', () => {
  const { data, body } = splitSource('\uFEFF---\ntitle: 带 BOM\n---\n正文。');
  assert.equal(data.title, '带 BOM');
  assert.equal(body, '正文。');
});

test('splitSource 保留没有 front-matter 的正文', () => {
  const { data, body } = splitSource('只有正文，没有头部。\n\n第二段。');
  assert.equal(data.title, undefined);
  assert.equal(body, '只有正文，没有头部。\n\n第二段。');
});

test('splitSource 兜底剥掉解析失败的头块，但不误删正文里的分隔线', () => {
  // parse 失败时 _content 会带着整段头部，这里按 YAML 键名特征剥掉。
  const broken = '---\ntitle: 兜底\ntags: [未闭合\n---\n正文。';
  const { body } = splitSource(broken);
  assert.ok(body.startsWith('正文。') || !body.includes('title: 兜底'), `正文不应包含 head 行：${body}`);

  // 正文里的 markdown 分隔线不能被当成 front-matter 删掉。
  const horizontal = splitSource('前言。\n\n---\n\n分隔线之后。');
  assert.ok(horizontal.body.includes('分隔线之后。'));
});

test('buildPayload 把调参写进 GPT-SoVITS 请求', () => {
  const voice = {
    textLang: 'zh', promptLang: 'zh', refAudio: 'a.wav', promptText: '参考', speed: 1.1,
    batchSize: 1, parallelInfer: false,
    tuning: { temperature: 0.6, topK: 5, topP: 0.9, repetitionPenalty: 1.2, seed: 42,
      textSplitMethod: 'cut2', fragmentInterval: 0.6, sampleSteps: 0, cfgRate: 0 }
  };
  const payload = buildPayload(voice, '要读的文字。');
  assert.equal(payload.text, '要读的文字。');
  assert.equal(payload.text_lang, 'zh');
  assert.equal(payload.temperature, 0.6);
  assert.equal(payload.top_k, 5);
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.repetition_penalty, 1.2);
  assert.equal(payload.seed, 42);
  assert.equal(payload.text_split_method, 'cut2');
  assert.equal(payload.fragment_interval, 0.6);
  assert.equal(payload.speed_factor, 1.1);
  assert.equal(payload.ref_audio_path, 'a.wav');
  assert.deepEqual(payload.aux_ref_audio_paths, []);
  assert.equal(payload.media_type, 'wav');
  assert.ok(!('sample_steps' in payload), '0 表示交给服务端默认，不要发给接口');

  const v5 = buildPayload({ ...voice, tuning: { ...voice.tuning, sampleSteps: 8, cfgRate: 1.5 } }, 'x');
  assert.equal(v5.sample_steps, 8);
  assert.equal(v5.cfg_rate, 1.5);
});

test('buildPayload 支持多段参考音频与部分缺省配置', () => {
  const payload = buildPayload({ refAudios: ['a.wav', 'b.wav'] }, 'x');
  assert.equal(payload.ref_audio_path, 'a.wav');
  assert.deepEqual(payload.aux_ref_audio_paths, ['b.wav']);
  assert.equal(payload.top_k, 15);
  assert.equal(payload.text_split_method, 'cut5');
  assert.equal(payload.seed, -1);
});

test('normalizeTuning 收敛越界参数并校验分割方式', () => {
  const tuning = normalizeTuning({ temperature: 9, topK: 1.4, topP: 9, repetitionPenalty: 9,
    fragmentInterval: 9, sampleSteps: 99, cfgRate: 9, seed: '7' });
  assert.equal(tuning.temperature, 2);
  assert.equal(tuning.topK, 1);
  assert.equal(tuning.topP, 1);
  assert.equal(tuning.repetitionPenalty, 2);
  assert.equal(tuning.fragmentInterval, 2);
  assert.equal(tuning.sampleSteps, 64);
  assert.equal(tuning.cfgRate, 4);
  assert.equal(tuning.seed, 7);
  assert.equal(tuning.textSplitMethod, 'cut5');
  assert.equal(normalizeTuning({ temperature: 0.05 }).temperature, 0.1);
  assert.equal(normalizeTuning({ topP: 0 }).topP, 0.1);
  assert.equal(normalizeTuning({ seed: -1 }).seed, -1);
  assert.throws(() => normalizeTuning({ textSplitMethod: 'cut9' }), /textSplitMethod/);
});

test('concatPcm 支持按块指定静音长度', () => {
  const part = data => ({ channels: 1, sampleRate: 1000, bitsPerSample: 16, data: Buffer.from(data) });
  const plain = concatPcm([part([1, 0]), part([2, 0])]);
  assert.equal(plain.length, 4);
  const single = concatPcm([part([1, 0]), part([2, 0])], 400);
  assert.equal(single.length, 2 + 800 + 2, '400ms × 1000Hz × 2 字节');
  const perChunk = concatPcm([part([1, 0]), part([2, 0]), part([3, 0])], [100, 400]);
  assert.equal(perChunk.length, 2 + 200 + 2 + 800 + 2);
  assert.throws(() => concatPcm([part([1, 0]), { ...part([2, 0]), sampleRate: 8000 }]), /格式/);
});

test('detectSovitsVersion 从文件头两个字节识别微调权重版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-version-'));
  try {
    const file = path.join(dir, 'weights.pth');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('06'), Buffer.from([3, 4, 0])]));
    assert.equal(detectSovitsVersion(file), 'v2ProPlus');
    fs.writeFileSync(file, '07');
    assert.equal(detectSovitsVersion(file), 'v5dev');
    fs.writeFileSync(file, 'PK\x03\x04');
    assert.equal(detectSovitsVersion(file), null);
    assert.equal(detectSovitsVersion(path.join(dir, 'missing.pth')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inferVersion 读取 tts_infer.yaml 里 custom 段的 version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-infer-'));
  try {
    fs.writeFileSync(path.join(dir, 'tts_infer.yaml'),
      'custom:\n  device: cuda\n  version: v5turbo\nv1:\n  version: v1\n');
    assert.equal(inferVersion({ gptSovits: { dir, config: 'tts_infer.yaml' } }), 'v5turbo');
    assert.equal(inferVersion({ gptSovits: { dir: path.join(dir, 'missing'), config: 'nope.yaml' } }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


