import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RULES_FILE, apply, inject, name } from '../index.js';

/** 一句用户手打的消息。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** 一个够用的假 Context：效果立即执行，事件手工触发。 */
function makeHarness({ withAgents = true, withTools = true, withWebServer = true } = {}) {
  const handlers = new Map();
  const events = [];
  const tools = [];
  const routes = [];
  const roots = [];
  const warnings = [];
  const services = {};
  if (withAgents) services.agents = { roots: () => roots };
  if (withTools) {
    services.tools = {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    };
  }
  if (withWebServer) {
    services.webServer = {
      register(route) {
        routes.push(route);
        return () => {};
      },
    };
  }
  const ctx = {
    effect(fn) {
      return fn();
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    get(serviceName) {
      return services[serviceName];
    },
    // 模拟 cordis 的 ctx.inject：依赖齐了才跑 callback。
    inject(deps, callback) {
      const ready = Array.isArray(deps) && deps.every((name) => services[name] !== undefined);
      if (!ready) return undefined;
      callback({ effect: (fn) => fn(), webServer: services.webServer });
      return undefined;
    },
    emit(event, payload) {
      events.push({ event, payload });
    },
    logger: { warn: (message) => warnings.push(message) },
  };
  const fire = async (event, payload) => {
    for (const handler of handlers.get(event) ?? []) {
      if (event === 'agent/pre-step') await handler(payload, async () => undefined);
      else await handler(payload);
    }
  };
  return { ctx, fire, tools, roots, warnings, events, routes };
}

/** 造一次 HTTP 调用打给面板 RPC。 */
function makeExchange(endpoint, payload) {
  const text = JSON.stringify({ rpcId: 'test-rpc', method: endpoint, payload: payload ?? {} });
  const req = {
    method: 'POST',
    url: `/dsh-subtext/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8');
    },
  };
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
      return this;
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk);
    },
  };
  return { req, res };
}

/** 打一次 RPC 并返回 envelope.result。 */
async function rpc(harness, endpoint, payload) {
  const { req, res } = makeExchange(endpoint, payload);
  await harness.routes[0].handler(req, res);
  return JSON.parse(res.body).result;
}

/** 一个会话；`scoped: false` 用来模拟拿不到 systemPrompt 的情况。 */
function makeAgent(id, { scoped = true, parent = null } = {}) {
  const sections = [];
  const steered = [];
  const agentCtx = {
    get(serviceName) {
      if (serviceName !== 'systemPrompt' || !scoped) return undefined;
      return {
        section(definition) {
          sections.push(definition);
          return () => {};
        },
      };
    },
    effect(fn) {
      return fn();
    },
  };
  const agent = {
    id,
    ctx: agentCtx,
    session: parent ? { parentSession: parent } : {},
    async steer(message) {
      steered.push(message);
    },
  };
  agent.sections = sections;
  agent.steered = steered;
  return agent;
}

/** 每个测试一个独立的 $DSH_HOME。 */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subtext-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/** 建一个已经注册好段的会话。 */
async function boot(harness, agent) {
  harness.roots.push(agent);
  await apply(harness.ctx, {});
  await harness.fire('agent/created', { agent });
}

test('插件面：名字、依赖、文件面', () => {
  assert.equal(name, 'subtext');
  // 只有 systemPrompt 是硬依赖；agents / tools 都按可选处理
  assert.deepEqual(inject, ['systemPrompt']);
  assert.equal(RULES_FILE, 'dsh-subtext.json');
});

test('会话创建后注册段，聊天档含第一层', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    assert.equal(agent.sections.length, 1);
    assert.equal(agent.sections[0].name, 'subtext');
    assert.equal(agent.sections[0].interpolate, false);
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
    assert.equal(agent.sections[0].text().includes('第二层'), false);
  });
});

test('工作消息让整段消失，聊天消息让它回来', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('帮我把这个插件改一下') });
    assert.equal(agent.sections[0].text(), '');

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('我今天有点累') });
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('两个会话各判各的，不串档', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const chat = makeAgent('chat-window');
    const work = makeAgent('work-window');
    harness.roots.push(chat, work);
    await apply(harness.ctx, {});
    await harness.fire('agent/created', { agent: chat });
    await harness.fire('agent/created', { agent: work });

    await harness.fire('agent/inbox/inserted', { agent: work, message: userMessage('部署到服务器') });

    assert.equal(work.sections[0].text(), '');
    assert.match(chat.sections[0].text(), /第一层 · 情感/);
  });
});

test('插件注入的消息不切档', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await harness.fire('agent/inbox/inserted', {
      agent,
      message: { role: 'user', content: [{ type: 'text', text: '插件 部署 重启' }], source: { kind: 'plugin' } },
    });
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('改文件下一句就生效，不用重启', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await writeFile(join(home, RULES_FILE), JSON.stringify({ depth: 3 }), 'utf8');
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('我今天有点累') });

    const text = agent.sections[0].text();
    assert.match(text, /第二层 · 此刻的需求/);
    assert.match(text, /第三层 · 说不出口的部分，与我/);
    assert.match(text, /记忆来源/);
  });
});

test('enabled: false 时不注入', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await writeFile(join(home, RULES_FILE), JSON.stringify({ enabled: false }), 'utf8');
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('在吗') });

    assert.equal(agent.sections[0].text(), '');
  });
});

test('规则文件坏掉不崩，保留上一份', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await writeFile(join(home, RULES_FILE), '{ 这不是 json', 'utf8');
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('在吗') });

    assert.match(agent.sections[0].text(), /第一层 · 情感/);
    assert.ok(harness.warnings.some((line) => line.includes('rules file')));
  });
});

test('子代理默认不注册段（scope: root）', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const root = makeAgent('root');
    const child = makeAgent('child', { parent: 'root' });
    harness.roots.push(root);
    await apply(harness.ctx, {});
    await harness.fire('agent/created', { agent: child });

    assert.equal(child.sections.length, 0);
  });
});

test('拿不到 scoped systemPrompt 时降级为不注入，并留一行警告', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1', { scoped: false });
    await boot(harness, agent);

    assert.equal(agent.sections.length, 0);
    assert.ok(harness.warnings.some((line) => line.includes('no scoped systemPrompt')));
  });
});

test('缺少 agents 服务时仍能加载，按根会话处理', async () => {
  await withHome(async () => {
    const harness = makeHarness({ withAgents: false });
    const agent = makeAgent('s1');
    harness.roots.push(agent);
    await apply(harness.ctx, {});
    await harness.fire('agent/created', { agent });

    assert.equal(agent.sections.length, 1);
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('缺少 tools 服务时仍能加载，只是没有 subtext_rule', async () => {
  await withHome(async () => {
    const harness = makeHarness({ withTools: false });
    const agent = makeAgent('s1');
    await boot(harness, agent);

    assert.equal(harness.tools.length, 0);
    assert.equal(agent.sections.length, 1);
  });
});

test('档位变化时广播 subtext/band，同档连续两条不重复', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const bands = () => harness.events.filter((row) => row.event === 'subtext/band');

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这个回复不错') });
    assert.equal(bands().length, 1, '第一次判定就该广播');
    assert.equal(bands()[0].payload.band, 'chat');
    assert.equal(bands()[0].payload.sessionId, 's1');
    assert.equal(bands()[0].payload.depth, 1);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('我今天有点累') });
    assert.equal(bands().length, 1, '同档不重复广播');

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('帮我部署一下') });
    assert.equal(bands().length, 2);
    assert.equal(bands()[1].payload.band, 'work');
    assert.ok(bands()[1].payload.hits.includes('部署'));
  });
});

test('日志按天写一行一条，只记用户消息', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('帮我看下日志') });
    await harness.fire('agent/inbox/inserted', {
      agent,
      message: { role: 'user', content: [{ type: 'text', text: '插件' }], source: { kind: 'plugin' } },
    });

    const names = await readdir(home);
    const logName = names.find((entry) => entry.startsWith('dsh-subtext-') && entry.endsWith('.jsonl'));
    assert.ok(logName, `expected a log file, got ${names.join(', ')}`);

    const rows = (await readFile(join(home, logName), 'utf8')).trim().split('\n');
    assert.equal(rows.length, 1);
    const row = JSON.parse(rows[0]);
    assert.equal(row.band, 'work');
    assert.ok(row.hits.includes('日志'));
  });
});

test('subtext_rule 能列规则、加词，且新词下一句就生效', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const tool = harness.tools.find((definition) => definition.name === 'subtext_rule');
    assert.ok(tool, 'subtext_rule 应已注册');

    const listed = await tool.execute({ action: 'list' }, { agent });
    assert.equal(listed.ok, true);
    assert.equal(listed.depth, 1);

    const added = await tool.execute(
      { action: 'add', kind: 'work', word: '重构', why: '交代活' },
      { agent },
    );
    assert.equal(added.action, 'added');
    assert.ok(added.workHints.includes('重构'));

    const stored = JSON.parse(await readFile(join(home, RULES_FILE), 'utf8'));
    assert.deepEqual(stored.workHints, ['重构'], '文件只写增量，不抄全表');

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这次重构你来') });
    assert.equal(agent.sections[0].text(), '');

    const chatRule = await tool.execute(
      { action: 'add', kind: 'chat', word: '重构', why: '这事儿我其实只是想吐槽' },
      { agent },
    );
    assert.ok(chatRule.chatHints.includes('重构'));

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这次重构你来') });
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('subtext_rule 拒绝子代理', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const root = makeAgent('root');
    const child = makeAgent('child', { parent: 'root' });
    harness.roots.push(root);
    await apply(harness.ctx, {});
    const tool = harness.tools.find((definition) => definition.name === 'subtext_rule');
    await assert.rejects(
      () => tool.execute({ action: 'list' }, { agent: child }),
      /只能在主会话使用/,
    );
  });
});

test('详情页面板：get 返回自己的词、内置词和生效词', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    assert.equal(harness.routes.length, 1);
    assert.equal(harness.routes[0].path, '/dsh-subtext');

    const result = await rpc(harness, 'get');
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.mine, []);
    assert.ok(result.value.builtin.includes('插件'));
    assert.ok(result.value.merged.includes('插件'));
    assert.equal(result.value.depth, 1);
  });
});

test('详情页面板：save 清洗词表、落盘，并在下一句生效', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const saved = await rpc(harness, 'save', { workHints: [' 重构 ', '重构', '', 42, '部署'] });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.value.mine, ['重构', '部署']);

    const stored = JSON.parse(await readFile(join(home, RULES_FILE), 'utf8'));
    assert.deepEqual(stored.workHints, ['重构', '部署']);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这次重构你来') });
    assert.equal(agent.sections[0].text(), '');
  });
});

test('详情页面板：存空表 = 一条都不触发，全当日常对话', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await rpc(harness, 'save', { workHints: ['重构'] });
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这次重构你来') });
    assert.equal(agent.sections[0].text(), '');

    await rpc(harness, 'save', { workHints: [] });
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('这次重构你来') });
    assert.match(agent.sections[0].text(), /第一层 · 情感/);

    // 内置词也一起停用：部署不再触发工作档
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('帮我部署一下服务器') });
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('详情页面板：坏请求和未知端点都只回错误，不抛', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const bad = await rpc(harness, 'save', { workHints: '重构' });
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /数组/);

    const unknown = await rpc(harness, 'nope');
    assert.equal(unknown.ok, false);
  });
});

test('详情页面板：save 能改档位，下一句立刻按新档位读', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const saved = await rpc(harness, 'save', { workHints: [], depth: 3 });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.depth, 3);

    const stored = JSON.parse(await readFile(join(home, RULES_FILE), 'utf8'));
    assert.equal(stored.depth, 3);

    // 不重启，下一句就该是三层
    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('我今天有点累') });
    assert.match(agent.sections[0].text(), /第三层 · 说不出口的部分，与我/);
  });
});

test('详情页面板：非法档位被拒，不动文件', async () => {
  await withHome(async (home) => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const bad = await rpc(harness, 'save', { workHints: [], depth: 5 });
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /1、2、3/);

    const missing = await rpc(harness, 'save');
    assert.equal(missing.ok, false);
  });
});

test('没有 webServer 时不崩，也不挂路由', async () => {
  await withHome(async () => {
    const harness = makeHarness({ withWebServer: false });
    const agent = makeAgent('s1');
    await boot(harness, agent);

    assert.equal(harness.routes.length, 0);
    assert.match(agent.sections[0].text(), /第一层 · 情感/);
  });
});

test('subtext_pass 按档位校验：depth 3 三层都要', async () => {
  await withHome(async (home) => {
    await writeFile(join(home, RULES_FILE), JSON.stringify({ workHints: [], depth: 3 }), 'utf8');
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const pass = harness.tools.find((tool) => tool.name === 'subtext_pass');
    assert.ok(pass, 'subtext_pass 应已注册');

    await assert.rejects(() => pass.execute({ feeling: '有点累' }, { agent }), /第二层/);
    await assert.rejects(
      () => pass.execute({ feeling: '有点累', need: '想被听见' }, { agent }),
      /第三层/,
    );

    const ok = await pass.execute(
      { feeling: '有点累', need: '想被听见', unsaid: '不想承认没人陪' },
      { agent },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.depth, 3);
  });
});

test('subtext_pass 在 depth 1 只要一层', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    const pass = harness.tools.find((tool) => tool.name === 'subtext_pass');
    const ok = await pass.execute({ feeling: '只是随口' }, { agent });
    assert.equal(ok.depth, 1);
  });
});

test('回合关闭时没打卡，就把回合拽回来；同一回合只拦一次', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('在吗') });
    await harness.fire('agent/turn-stopping', { agent, turn: 1 });

    assert.equal(agent.steered.length, 1);
    assert.match(agent.steered[0].content[0].text, /subtext_pass/);

    await harness.fire('agent/turn-stopping', { agent, turn: 1 });
    assert.equal(agent.steered.length, 1, '同一回合不重复拦，防死循环');
  });
});

test('打过卡就不拦，工作档也不拦', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const chat = makeAgent('chat');
    const work = makeAgent('work');
    harness.roots.push(chat, work);
    await apply(harness.ctx, {});
    await harness.fire('agent/created', { agent: chat });
    await harness.fire('agent/created', { agent: work });

    await harness.fire('agent/inbox/inserted', { agent: chat, message: userMessage('在吗') });
    const pass = harness.tools.find((tool) => tool.name === 'subtext_pass');
    await pass.execute({ feeling: '打个招呼' }, { agent: chat });
    await harness.fire('agent/turn-stopping', { agent: chat, turn: 1 });
    assert.equal(chat.steered.length, 0);

    await harness.fire('agent/inbox/inserted', { agent: work, message: userMessage('帮我看一下这个接口') });
    await harness.fire('agent/turn-stopping', { agent: work, turn: 1 });
    assert.equal(work.steered.length, 0);
  });
});

test('新的一条用户消息会清掉上一轮的打卡状态', async () => {
  await withHome(async () => {
    const harness = makeHarness();
    const agent = makeAgent('s1');
    await boot(harness, agent);
    const pass = harness.tools.find((tool) => tool.name === 'subtext_pass');

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('在吗') });
    await pass.execute({ feeling: '打个招呼' }, { agent });
    await harness.fire('agent/turn-stopping', { agent, turn: 1 });
    assert.equal(agent.steered.length, 0);

    await harness.fire('agent/inbox/inserted', { agent, message: userMessage('今天好累') });
    await harness.fire('agent/turn-stopping', { agent, turn: 2 });
    assert.equal(agent.steered.length, 1);
  });
});
