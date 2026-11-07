import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  classify,
  clampDepth,
  extractText,
  isUserMessage,
  mergeRules,
  sourceKind,
  withWord,
} from '../rules.js';

const rules = mergeRules({}, {});

test('默认规则来自内置默认值', () => {
  assert.equal(DEFAULTS.depth, 1);
  assert.equal(rules.enabled, true);
  assert.equal(rules.scope, 'root');
  assert.equal(rules.log, true);
  assert.ok(rules.workHints.includes('插件'));
});

test('用户文件覆盖 config，config 覆盖默认', () => {
  const merged = mergeRules({ depth: 2, enabled: true }, { depth: 3, enabled: false });
  assert.equal(merged.depth, 3);
  assert.equal(merged.enabled, false);
  assert.equal(mergeRules({ depth: 2 }, {}).depth, 2);
});

test('深度夹回 1..3', () => {
  assert.equal(clampDepth(0), 1);
  assert.equal(clampDepth('2'), 2);
  assert.equal(clampDepth(9), 3);
  assert.equal(clampDepth('x'), 1);
  assert.equal(mergeRules({}, { depth: 99 }).depth, 3);
});

test('文件里写了自己的工作语，就整体接管，内置的不再参与', () => {
  const owned = mergeRules({}, { workHints: [' 插件 ', '插件', '', 3, '重构'] });
  assert.deepEqual(owned.workHints, ['插件', '重构']);
  assert.equal(owned.builtinActive, false);
  assert.deepEqual(owned.leadVerbs, [], '内置祈使开头一并停用');
});

test('接管之后，内置词和祈使开头都算日常对话', () => {
  const owned = mergeRules({}, { workHints: ['重构'] });
  assert.equal(classify('这个插件改一下', owned).band, 'chat');
  assert.equal(classify('检查一下', owned).band, 'chat');
  assert.equal(classify('帮我部署一下', owned).band, 'chat');
  assert.equal(classify('这次重构你来', owned).band, 'work');
});

test('文件里没写工作语时，内置照常生效', () => {
  const fallback = mergeRules({}, { depth: 3 });
  assert.equal(fallback.builtinActive, true);
  assert.equal(classify('这个插件改一下', fallback).band, 'work');
  assert.equal(classify('检查一下', fallback).band, 'work');
});

test('removeHints 能把默认词减掉', () => {
  const merged = mergeRules({}, { removeHints: ['插件'] });
  assert.equal(merged.workHints.includes('插件'), false);
  assert.ok(merged.workHints.includes('接口'));
});

test('闲聊判 chat，交代活判 work', () => {
  assert.equal(classify('这个回复不错', rules).band, 'chat');
  assert.equal(classify('我今天有点累', rules).band, 'chat');

  const work = classify('帮我把这个插件改一下', rules);
  assert.equal(work.band, 'work');
  assert.ok(work.hits.includes('插件'));
  assert.equal(work.reason, 'work-hint');
});

test('开头的祈使动词比正文里的工作词更早成立', () => {
  const result = classify('验证一下这个说法对不对', rules);
  assert.equal(result.band, 'work');
  assert.equal(result.reason, 'lead-verb');
});

test('chatHints 优先级最高，用来纠错', () => {
  const custome = mergeRules({}, { chatHints: ['插件'] });
  const result = classify('这个插件我不想再聊了', custome);
  assert.equal(result.band, 'chat');
  assert.equal(result.reason, 'chat-hint');
});

test('短句加完成态算汇报，不算交代活', () => {
  const report = classify('重启了', rules);
  assert.equal(report.band, 'chat');
  assert.equal(report.reason, 'report');
  assert.equal(classify('验证完了', rules).band, 'chat');
  assert.equal(classify('部署成功了', rules).band, 'chat');
  assert.equal(classify('测试完成！', rules).band, 'chat');
  assert.equal(classify('日志清啦', rules).band, 'chat');
});

test('汇报规则不吞真正的交代', () => {
  assert.equal(classify('重启', rules).band, 'work');
  assert.equal(classify('重启服务器', rules).band, 'work');
  assert.equal(classify('帮我把这个插件改一下', rules).band, 'work');
  // 长句即使以「了」收尾也还是交代
  assert.equal(classify('你把那个插件的配置文件重新生成一遍了没有', rules).band, 'work');
});

test('只匹配前 200 字，后面的工作词不参与判定', () => {
  const long = `${'啊'.repeat(200)}插件`;
  assert.equal(classify(long, rules).band, 'chat');
});

test('空消息判不出，调用方保持原档', () => {
  assert.equal(classify('', rules).band, null);
  assert.equal(classify('   ', rules).band, null);
  assert.equal(classify(undefined, rules).band, null);
});

test('只认用户亲手打的消息', () => {
  const user = { role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } };
  const plugin = { role: 'user', content: [{ type: 'text', text: '插件' }], source: { kind: 'plugin' } };
  const bare = { role: 'user', content: [{ type: 'text', text: '裸的' }] };
  assert.equal(isUserMessage(user), true);
  assert.equal(isUserMessage(plugin), false);
  assert.equal(isUserMessage(bare), false);
  assert.equal(isUserMessage({ role: 'assistant', source: { kind: 'user' } }), false);

  assert.equal(sourceKind(user), 'user');
  assert.equal(sourceKind(bare), null);
});

test('提取文本块，忽略非文本块', () => {
  assert.equal(extractText({ content: '直接字符串' }), '直接字符串');
  assert.equal(
    extractText({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'xx' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '第一段\n第二段',
  );
  assert.equal(extractText({ content: [{ type: 'image' }] }), '');
  assert.equal(extractText(undefined), '');
});

test('加词会拒绝空词和重复词', () => {
  assert.deepEqual(withWord(['插件'], '接口'), ['插件', '接口']);
  assert.throws(() => withWord(['插件'], '  '), /不能为空/);
  assert.throws(() => withWord(['插件'], '插件'), /已经有/);
});
