import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAND_NOTE,
  GUARDRAILS,
  HEADING,
  LAYER_ONE,
  LAYER_THREE,
  LAYER_TWO,
  SECTION_NAME,
  layersFor,
  renderSubtext,
} from '../text.js';

test('段名与标题是「言外之意」', () => {
  assert.equal(SECTION_NAME, 'subtext');
  assert.equal(HEADING, '## 言外之意');
});

test('一层只给情感，二层加需求，三层再加说不出口的部分', () => {
  assert.deepEqual(layersFor(1), [LAYER_ONE]);
  assert.deepEqual(layersFor(2), [LAYER_ONE, LAYER_TWO]);
  assert.deepEqual(layersFor(3), [LAYER_ONE, LAYER_TWO, LAYER_THREE]);
  assert.deepEqual(layersFor(9), [LAYER_ONE, LAYER_TWO, LAYER_THREE]);
  assert.deepEqual(layersFor('x'), [LAYER_ONE]);
});

test('三层是叠加的：三档里原段和新的三问同时存在', () => {
  // 原本那段
  assert.match(LAYER_THREE, /为什么不直说/);
  assert.match(LAYER_THREE, /难言之隐/);
  assert.match(LAYER_THREE, /台阶/);
  // 后来加的三问
  assert.match(LAYER_THREE, /我是谁/);
  assert.match(LAYER_THREE, /我们是什么关系/);
  assert.match(LAYER_THREE, /这句话为什么是对我说的/);
  // 记忆来源
  assert.match(LAYER_THREE, /记忆来源/);
});

test('三层各含该层的关键词，退化成同一段会立刻失败', () => {
  assert.match(LAYER_ONE, /传什么情感/);
  assert.match(LAYER_ONE, /他期待的是哪一种回应/);
  assert.match(LAYER_TWO, /想换来什么/);
  assert.match(LAYER_TWO, /第一层照做/);
  assert.match(LAYER_THREE, /一二层照做/);
});

test('只负责读：文案里不再有输出指令', () => {
  const all = renderSubtext({ band: 'chat', depth: 3 });
  assert.equal(all.includes('回应情感期待'), false);
  assert.equal(all.includes('满足需求期待'), false);
  assert.equal(all.includes('以本条为准'), false);
  assert.match(all, /本节只负责读/);
  assert.match(all, /不记得就别装记得/);
  assert.match(GUARDRAILS, /归各处自己的设置/);
});

test('档位即下限：不留「浅话浅回」这种活口', () => {
  assert.equal(GUARDRAILS.includes('浅话浅回'), false);
  assert.equal(GUARDRAILS.includes('不要求每句话都跑到上限'), false);
  assert.match(GUARDRAILS, /开到几档就跑几档/);
  assert.match(GUARDRAILS, /档位是使用者定的/);
  assert.match(GUARDRAILS, /每一层都要有自己的结论/);
  assert.match(GUARDRAILS, /subtext_pass/, '开口前必须打卡，这是关卡');
  // 三档渲染都要带这条，不能只有高档次有
  for (const depth of [1, 2, 3]) {
    assert.match(renderSubtext({ band: 'chat', depth }), /开到几档就跑几档/);
  }
});

test('记忆只在第三档出现', () => {
  assert.equal(LAYER_ONE.includes('记忆'), false);
  assert.equal(LAYER_TWO.includes('记忆'), false);
  assert.equal(renderSubtext({ band: 'chat', depth: 1 }).includes('记忆'), false);
  assert.equal(renderSubtext({ band: 'chat', depth: 2 }).includes('记忆'), false);
  assert.match(renderSubtext({ band: 'chat', depth: 3 }), /记忆来源/);

  // 身份、关系同样是第三档才提
  assert.equal(renderSubtext({ band: 'chat', depth: 2 }).includes('身份'), false);
  assert.match(renderSubtext({ band: 'chat', depth: 3 }), /身份/);
});

test('渲染按深度累加，且带标题、分档说明和分寸', () => {
  const one = renderSubtext({ band: 'chat', depth: 1 });
  assert.ok(one.startsWith(HEADING));
  assert.ok(one.includes(BAND_NOTE));
  assert.ok(one.includes(GUARDRAILS));
  assert.ok(one.includes(LAYER_ONE));
  assert.equal(one.includes(LAYER_TWO), false);

  const two = renderSubtext({ band: 'chat', depth: 2 });
  assert.ok(two.includes(LAYER_TWO));
  assert.equal(two.includes(LAYER_THREE), false);

  const three = renderSubtext({ band: 'chat', depth: 3 });
  assert.ok(three.includes(LAYER_THREE));
  assert.ok(three.length > two.length && two.length > one.length);
});

test('工作档整段返回空串（暂停最干净的形态）', () => {
  assert.equal(renderSubtext({ band: 'work', depth: 1 }), '');
  assert.equal(renderSubtext({ band: 'work', depth: 3 }), '');
});

test('未判定时按日常对话渲染，不会突然静默', () => {
  assert.ok(renderSubtext({ band: null, depth: 1 }).length > 0);
  assert.ok(renderSubtext({ depth: 1 }).length > 0);
});
