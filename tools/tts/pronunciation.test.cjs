'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRep, formatEntry, validateEntries, mergeRep } = require('./pronunciation.cjs');

test('parseRep 读取词表并跳过坏行', () => {
  const content = "重庆: ['chong2', 'qing4']\n坏行没有冒号\n银行: ['yin2', 'hang2']\n空: []";
  const entries = parseRep(content);
  assert.ok(entries instanceof Map);
  assert.deepEqual([...entries], [['重庆', ['chong2', 'qing4']], ['银行', ['yin2', 'hang2']]]);
  assert.equal(parseRep('').size, 0);
  assert.equal(parseRep(null).size, 0);
});

test('formatEntry 写出 GPT-SoVITS 认识的词表格式', () => {
  assert.equal(formatEntry('重庆', ['chong2', 'qing4']), "重庆: ['chong2', 'qing4']");
});

test('validateEntries 要求拼音个数与字数一致、格式合法', () => {
  const { valid, errors } = validateEntries({
    重庆: ['chong2', 'qing4'],
    银行: ['yin2'],
    重: ['chong1'],
    '重:庆': ['chong2', 'qing4'],
    '': ['x'],
    行: ['abc']
  });
  assert.deepEqual(valid, [['重庆', ['chong2', 'qing4']], ['重', ['chong1']]]);
  assert.ok(errors.some(message => message.includes('个字却写了')), errors.join('；'));
  assert.ok(errors.some(message => message.includes('冒号')), errors.join('；'));
  assert.ok(errors.some(message => message.includes('拼音格式')), errors.join('；'));
  assert.ok(validateEntries(null).errors.length);
  assert.deepEqual(validateEntries({}).valid, []);
});

test('mergeRep 原地覆盖已有词条、追加新词并保持顺序', () => {
  const original = "重庆: ['chong2', 'qing4']\n行: ['xing2']\n";
  const entries = new Map([['重庆', ['chong2', 'qing4']], ['行', ['hang2']], ['银行', ['yin2', 'hang2']]]);
  const { content, added, updated } = mergeRep(original, entries);
  assert.deepEqual(updated, ['行']);
  assert.deepEqual(added, ['银行']);
  assert.equal(content, "重庆: ['chong2', 'qing4']\n行: ['hang2']\n银行: ['yin2', 'hang2']\n");
  assert.ok(!/\n{2,}/.test(content), '词表里不能留空行，g2pw 读取会崩');

  const again = mergeRep(content, entries);
  assert.deepEqual([again.added, again.updated], [[], []]);
  assert.equal(again.content, content);
});
