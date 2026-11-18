'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSource } = require('./cli.cjs');

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

test('splitSource 不会把正文首行是列表或引用的内容当成头部', () => {
  const { body } = splitSource('- 列表项一\n- 列表项二');
  assert.equal(body, '- 列表项一\n- 列表项二');
});
