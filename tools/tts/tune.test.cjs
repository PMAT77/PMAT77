'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VARIANTS, describeTuning, parseArgs } = require('./tune.cjs');
const { TUNING } = require('./cli.cjs');

test('VARIANTS 覆盖八组单参数对比，且组间只有一处差异', () => {
  assert.equal(VARIANTS.length, 8);
  assert.equal(new Set(VARIANTS.map(variant => variant.id)).size, VARIANTS.length);
  const baseline = VARIANTS.find(variant => variant.id === 'baseline');
  assert.deepEqual(baseline.tuning, {});
  for (const variant of VARIANTS.filter(item => item !== baseline)) {
    assert.equal(Object.keys(variant.tuning).length, 1, `${variant.id} 只能改一个参数`);
    const key = Object.keys(variant.tuning)[0];
    assert.ok(key in TUNING, `${variant.id} 改了不认识的参数 ${key}`);
    assert.notEqual(variant.tuning[key], TUNING[key], `${variant.id} 的参数应区别于默认值`);
  }
});

test('describeTuning 输出可读的参数摘要', () => {
  const text = describeTuning({ tuning: { ...TUNING, temperature: 0.6, topK: 5 } });
  assert.match(text, /temperature 0\.6/);
  assert.match(text, /top_k 5/);
  assert.match(text, /cut5/);
});

test('parseArgs 读取试听参数并拒绝未知取值', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.serve, false);
  assert.equal(defaults.variant, '');
  assert.equal(defaults.dryRun, false);
  assert.ok(defaults.chars >= 40);
  const options = parseArgs(['--serve', '--chars', '120', '--variant', 'temp-06', '--dry-run']);
  assert.deepEqual(options, { serve: true, chars: 120, variant: 'temp-06', dryRun: true });
  assert.throws(() => parseArgs(['--variant', 'nope']), /未知的 --variant/);
  assert.throws(() => parseArgs(['--chars', '10']), /chars/);
});
