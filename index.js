/**
 * 言外之意（dsh-subtext）—— 让 AI 在日常对话里听字面底下那一层。
 *
 * 两件事：
 * - **分档**：消息进收件箱时判一次「这是跟我说话，还是交代活」。工作档整段不注入，
 *   就是暂停；聊天档按 1/2/3 层注入理解方法（情感 → 需求 → 说不出口的部分）。
 * - **可改写**：边界词写在 `$DSH_HOME/dsh-subtext.json`，改完下一句生效，不用重启；
 *   根会话还能用 `subtext_rule` 当场把一句话定性写进边界。
 *
 * 为什么判定必须发生在 `agent/inbox/inserted` 而不是 `agent/pre-step`：
 * agent loop 在 pre-step **之前**就组装好提示词了，等到 pre-step 再判，这一轮用的
 * 已经是上一轮的档位。
 *
 * 为什么段要按 agent 注册：全局段不知道是谁在组装，多窗口下会把 A 窗口的判定
 * 用到 B 窗口。通过 `agent.ctx` 注册的同名段只对这个会话生效，且随会话释放撤销。
 * 拿不到 scoped 注册时宁可不注入——串档比缺失更糟。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { randomUUID } from 'node:crypto'
import { DEFAULTS, classify, extractText, isUserMessage, mergeRules, sourceKind, withWord } from './rules.js';
import { SECTION_NAME, renderSubtext } from './text.js';

/** Loader row id，同时是这个插件在 patch 里的 id。 */
export const name = 'subtext';

/**
 * 只有提示词注册表是硬依赖。
 * `agents`（判根会话）和 `tools`（subtext_rule）都按可选处理：没有它们插件照样读，
 * 只是少掉判根和自改边界的入口。换一个环境装也能跑起来，不会因为缺一个服务就加载失败。
 */
export const inject = ['systemPrompt'];

/** 状态文件名（`$DSH_HOME` 下）。 */
export const RULES_FILE = 'dsh-subtext.json';

/** 判定日志的前缀；按天分文件，省掉轮转。 */
export const LOG_PREFIX = 'dsh-subtext';

/** 工具名。 */
export const RULE_TOOL_NAME = 'subtext_rule';

/** 三层打卡工具名。回合关闭前靠它判断这一轮到底读没读。 */
export const PASS_TOOL_NAME = 'subtext_pass';

/** 插件详情页面板用的 RPC 前缀。 */
export const RPC_CHANNEL = '/dsh-subtext';

/** 日志里只留消息开头这么多字，够认出来是哪句就行。 */
const LOG_TEXT_CHARS = 30;

/**
 * 一次「没文本可判」的判定结果，调用方保持原档。
 * `decided` 区分「还没判过」和「判成 chat」；
 * `passed` 记这一轮有没有调过 `subtext_pass`，`nudgedTurn` 记这一轮已经被拦过一次。
 */
const EMPTY_STATE = () => ({
  band: 'chat',
  hits: [],
  reason: 'default',
  text: '',
  at: 0,
  decided: false,
  passed: false,
  nudgedTurn: null,
});

/**
 * `$DSH_HOME`：优先环境变量，退回 `~/.dsh`。
 *
 * @returns {string}
 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv || path.join(homedir(), '.dsh');
}

/** 本地日期，给日志文件命名。 */
function localDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 宿主半。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] Loader row config（cordis.patch.yml 里的 config）
 */
export async function apply(ctx, config = {}) {
  const home = dshHome();
  const rulesFile = path.join(home, RULES_FILE);
  const warn = (message) => ctx.logger?.warn?.(`[subtext] ${message}`);

  /** 可选服务：拿不到（或没装）就返回 undefined，降级而不抛。 */
  const service = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  /** 有效规则。用户文件一变就整体换掉，段里的渲染函数读的永远是这一份。 */
  let rules = mergeRules(config, {});
  /** 上次读文件时的 mtime，用来判断要不要重读。 */
  let rulesMtimeMs = -1;
  /** 文件坏过一次就别每句都刷屏。 */
  let warnedBadFile = false;

  /** agentId → 该会话的判定状态。 */
  const states = new Map();
  /** 注册过段却拿不到 systemPrompt 的会话，只记一次日志。 */
  const degraded = new Set();

  /**
   * 读一遍用户文件，必要时更新 `rules`。只在消息到达时调用（低频），
   * 所以改完文件下一句就生效，又不会每次组装都碰磁盘。
   */
  const refreshRules = () => {
    let mtimeMs;
    try {
      mtimeMs = statSync(rulesFile).mtimeMs;
    } catch (error) {
      if (error?.code === 'ENOENT') return rules;
      warn(`stat ${rulesFile} failed: ${String(error)}`);
      return rules;
    }
    if (mtimeMs === rulesMtimeMs) return rules;
    try {
      const raw = JSON.parse(readFileSync(rulesFile, 'utf8'));
      rules = mergeRules(config, raw ?? {});
      rulesMtimeMs = mtimeMs;
      warnedBadFile = false;
    } catch (error) {
      if (!warnedBadFile) {
        warn(`rules file unreadable, keeping previous rules: ${String(error)}`);
        warnedBadFile = true;
      }
    }
    return rules;
  };

  /** 写一行判定日志。失败绝不影响对话。 */
  const writeLog = (entry) => {
    try {
      mkdirSync(home, { recursive: true });
      const file = path.join(home, `${LOG_PREFIX}-${localDay()}.jsonl`);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      warn(`log write failed: ${String(error)}`);
    }
  };

  /**
   * 这个会话算不算根会话。判不出来时按根处理：功能缺失比误伤子代理更可接受，
   * 而全局段那种串档的错法不可接受。
   */
  const isRootAgent = (agent) => {
    if (rules.scope === 'all') return true;
    try {
      const parent = agent?.session?.parentSession;
      if (parent !== undefined && parent !== null) return false;
    } catch {
      // session 拿不到就往下走
    }
    try {
      const roots = service('agents')?.roots?.();
      if (Array.isArray(roots) && roots.length > 0) {
        return roots.some((root) => root?.id === agent?.id);
      }
    } catch {
      // roots() 不可用就按根处理
    }
    return true;
  };

  /** 某个会话当前该注入的文本。关掉或工作档都返回空串，整段消失。 */
  const renderFor = (agent) => {
    if (!rules.enabled) return '';
    const state = states.get(agent?.id);
    return renderSubtext({ band: state?.band ?? 'chat', depth: rules.depth });
  };

  /** 给一个会话注册它自己的段。失败就降级为「不注入」，并记一行。 */
  const registerSection = (agent) => {
    let registry;
    try {
      registry = typeof agent.ctx?.get === 'function' ? agent.ctx.get('systemPrompt') : undefined;
    } catch {
      registry = undefined;
    }
    if (!registry || typeof registry.section !== 'function') {
      if (!degraded.has(agent.id)) {
        degraded.add(agent.id);
        warn(`no scoped systemPrompt for ${agent.id}; no injection for this session`);
      }
      return;
    }
    try {
      agent.ctx.effect(
        () =>
          registry.section({
            name: SECTION_NAME,
            order: rules.order,
            text: () => renderFor(agent),
            interpolate: false,
          }),
        'dsh-subtext.section()',
      );
    } catch (error) {
      if (!degraded.has(agent.id)) {
        degraded.add(agent.id);
        warn(`section registration failed for ${agent.id}: ${String(error)}`);
      }
    }
  };

  /**
   * 判一条消息并更新该会话的档位。
   *
   * @param {object} agent
   * @param {object} message UserMessage
   * @param {{onlyIfChanged?: boolean}} [options]
   */
  const record = (agent, message, options = {}) => {
    if (!agent || typeof agent.id !== 'string' || agent.id === '') return;
    if (!states.has(agent.id)) return;

    const kind = sourceKind(message);
    if (!isUserMessage(message)) {
      // 插件注入的消息（空闲倡议、记忆收尾）不参与判定：它们不是他说的话。
      return;
    }

    const text = extractText(message);
    const fresh = refreshRules();
    const result = classify(text, fresh);
    if (result.band === null) return;

    const state = states.get(agent.id);
    const changed = !state.decided || result.band !== state.band || result.reason !== state.reason;
    state.band = result.band;
    state.hits = result.hits;
    state.reason = result.reason;
    state.text = text.slice(0, LOG_TEXT_CHARS);
    state.at = Date.now();
    state.decided = true;

    // 新的一条用户消息 = 新的一轮：打卡状态清零。
    // pre-step 那条兜底路径（onlyIfChanged）不算新轮，不能清。
    if (!options.onlyIfChanged) {
      state.passed = false;
      state.nudgedTurn = null;
    }

    // 档位真的变了才广播：别的插件（语言层、语气层）可以拿它决定这一轮怎么说话。
    if (changed) {
      try {
        ctx.emit?.('subtext/band', {
          sessionId: agent.id,
          band: state.band,
          reason: state.reason,
          hits: state.hits,
          depth: fresh.depth,
        });
      } catch (error) {
        warn(`emit subtext/band failed: ${String(error)}`);
      }
    }

    if (options.onlyIfChanged && !changed) return;
    if (!fresh.log || !fresh.enabled) return;
    writeLog({
      ts: new Date().toISOString(),
      session: agent.id,
      band: state.band,
      reason: state.reason,
      hits: state.hits,
      depth: fresh.depth,
      source: kind,
      text: state.text,
    });
  };

  // 每个会话一条自己的段。只看根会话（scope: 'all' 时全都注册）。
  ctx.on('agent/created', ({ agent } = {}) => {
    if (!agent || typeof agent.id !== 'string') return;
    if (!isRootAgent(agent)) return;
    // 热加载时 apply 末尾的补注册可能已经走过一遍：同名段在同一层注册两次会抛。
    if (states.has(agent.id)) return;
    states.set(agent.id, EMPTY_STATE());
    registerSection(agent);
  });

  // 主路径：消息进收件箱就判，赶在第一次组装之前。
  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
    record(agent, message);
  });

  // 兜底：万一 inserted 没赶上（消息已在 inbox 里被 claimed），这里补判一次。
  // 同一句话且档位没变时不重复写日志。
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const last = messages[messages.length - 1];
    if (agent && last) record(agent, last, { onlyIfChanged: true });
    return next();
  });

  // 会话走了，状态一起走。
  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent && typeof agent.id === 'string') states.delete(agent.id);
  });

  /**
   * 回合关闭前的关卡。
   *
   * `agent/turn-stopping` 在一次回合眼看要结束时触发，这时还能 `agent.steer()`
   * 把话塞回去、让回合继续。日常对话里如果这一轮没调 `subtext_pass`，就在这里
   * 拦一次：三层还没过完，先补打卡。
   *
   * 三个放行条件：工作档不拦、已打卡不拦、同一回合只拦一次（防死循环）。
   */
  ctx.on('agent/turn-stopping', async ({ agent, turn } = {}) => {
    const state = agent && typeof agent.id === 'string' ? states.get(agent.id) : undefined;
    if (!state || !state.decided) return;

    const fresh = refreshRules();
    if (!fresh.enabled) return;
    if (state.band !== 'chat') return;
    if (state.passed) return;
    if (state.nudgedTurn === turn) return;

    state.nudgedTurn = turn;
    // 按当前档位出文案：1 层只说一层，依次类推（用户 2026-11-08 定）。
    const depth = Math.max(1, Math.min(3, Math.trunc(Number(fresh.depth) || 1)));
    const layerName = depth === 1 ? '一层' : depth === 2 ? '两层' : '三层';
    const nudgeText = `${layerName}还没过完，开口之前先调 \`subtext_pass\`，认真回答里面的问题，完整跑完插件禁止敷衍。`;
    try {
      await agent.steer({
        content: [
          {
            type: 'text',
            text: nudgeText,
          },
        ],
        role: 'user',
        id: randomUUID(),
        source: { kind: 'subtext' },
      });
    } catch (error) {
      warn(`steer failed: ${String(error)}`);
    }
  });

  // 工具注册是可选的一半：拿不到 helpers 时用一个原样返回的 identity，
  // 插件照样工作，只是少了自改边界的入口。
  let defineTool;
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  } catch {
    defineTool = (definition) => definition;
  }

  /** 读用户文件的原始 JSON（损坏就当空对象，别把用户的配置连坐掉）。 */
  const readRulesFile = async () => {
    try {
      const raw = JSON.parse(await readFile(rulesFile, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
      return {};
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`rules file parse failed, starting from empty: ${String(error)}`);
      return {};
    }
  };

  /** 原子写回用户文件。只动词表字段，不覆盖用户自己写的其它键。 */
  const writeRulesFile = async (next) => {
    await mkdir(home, { recursive: true });
    const tmp = `${rulesFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, rulesFile);
    rulesMtimeMs = -1;
    return next;
  };

  /**
   * `subtext_rule`：让根会话按一句话把边界改掉。
   *
   * 这是「边界可改写」的当场出口——用户说「这句别算工作」时，写进文件，
   * 下一句就按新边界判，而不是只答应一声。
   */
  const makeRuleTool = () =>
    defineTool({
      name: RULE_TOOL_NAME,
      description: [
        '管理和查看「言外之意」的分档边界（哪些话算日常对话、哪些算交代活）。',
        'list：列出当前有效规则和今天的最近判定。',
        'add：往 workHints 或 chatHints 加一个词，必须给 why；chatHints 优先级最高，用来纠正误判。',
        'remove：从对应词表里删一个词。',
        '注意：文件里一有 workHints，内置的工作词和内置祈使开头就全部停用，只剩列出的词算工作。'
          + '所以第一次往 work 里加词，等于接管整份工作语清单——加之前先 list 看看现在有哪些。',
        '改完立即生效（下一句消息就按新边界判），不需要重启。只能在主会话使用。',
      ].join('\n'),
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'add', 'remove'],
          description: 'list 只读；add / remove 改词表',
        },
        kind: {
          type: 'string',
          enum: ['work', 'chat'],
          description: 'add / remove 时必填：改哪张词表',
        },
        word: {
          type: 'string',
          description: 'add / remove 时必填：词或短语',
        },
        why: {
          type: 'string',
          description: 'add 时必填：为什么这个词该归这一档',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'ok'],
          properties: {
            action: { type: 'string', enum: ['list', 'added', 'removed'] },
            ok: { type: 'boolean' },
            message: { type: 'string' },
            path: { type: 'string' },
            depth: { type: 'number' },
            enabled: { type: 'boolean' },
            builtinActive: { type: 'boolean' },
            workHints: { type: 'array', items: { type: 'string' } },
            chatHints: { type: 'array', items: { type: 'string' } },
            leadVerbs: { type: 'array', items: { type: 'string' } },
            recent: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ts: { type: 'string' },
                  band: { type: 'string' },
                  reason: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          const lines = [];
          if (value.action === 'list') {
            lines.push(`边界文件：${value.path}`);
            lines.push(`启用：${value.enabled ? '是' : '否'}　深度：${value.depth} 层`);
            lines.push(`内置工作语：${value.builtinActive ? '生效中' : '已停用（只按上面写的判）'}`);
            lines.push(`工作词（${value.workHints.length}）：${value.workHints.join('、') || '(空)'}`);
            lines.push(`聊天词（${value.chatHints.length}）：${value.chatHints.join('、') || '(空)'}`);
            lines.push(`祈使开头（${value.leadVerbs.length}）：${value.leadVerbs.join('、') || '(空)'}`);
            if (value.recent.length > 0) {
              lines.push('', '今天最近的判定：');
              for (const row of value.recent) {
                lines.push(`- ${row.ts} ${row.band}（${row.reason}）${row.text}`);
              }
            }
          } else {
            lines.push(value.message || '已更新');
            lines.push(
              value.action === 'added'
                ? `工作词 ${value.workHints.length} 个，聊天词 ${value.chatHints.length} 个`
                : `工作词 ${value.workHints.length} 个，聊天词 ${value.chatHints.length} 个`,
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (!isRootAgent(agent)) throw new Error('subtext_rule 只能在主会话使用');
        const action = args?.action;
        const fresh = refreshRules();

        if (action === 'list') {
          let recent = [];
          try {
            const file = path.join(home, `${LOG_PREFIX}-${localDay()}.jsonl`);
            const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
            recent = lines.slice(-5).map((line) => {
              try {
                const row = JSON.parse(line);
                return { ts: row.ts ?? '', band: row.band ?? '', reason: row.reason ?? '', text: row.text ?? '' };
              } catch {
                return { ts: '', band: '', reason: '', text: line.slice(0, 40) };
              }
            });
          } catch {
            recent = [];
          }
          return {
            action: 'list',
            ok: true,
            path: rulesFile,
            enabled: fresh.enabled,
            depth: fresh.depth,
            builtinActive: fresh.builtinActive,
            workHints: fresh.workHints,
            chatHints: fresh.chatHints,
            leadVerbs: fresh.leadVerbs,
            recent,
          };
        }

        if (action !== 'add' && action !== 'remove') throw new Error('action 必须是 list / add / remove');
        const kind = args?.kind;
        if (kind !== 'work' && kind !== 'chat') throw new Error('kind 必须是 work 或 chat');
        const word = typeof args?.word === 'string' ? args.word.trim() : '';
        if (word === '') throw new Error('word 不能为空');

        const key = kind === 'work' ? 'workHints' : 'chatHints';
        const current = await readRulesFile();
        const fileList = Array.isArray(current[key])
          ? current[key].filter((item) => typeof item === 'string')
          : [];
        const removedList = Array.isArray(current.removeHints)
          ? current.removeHints.filter((item) => typeof item === 'string')
          : [];

        let nextList;
        let nextRemoved;
        if (action === 'add') {
          const why = typeof args?.why === 'string' ? args.why.trim() : '';
          if (why === '') throw new Error('add 需要 why：为什么这个词该归这一档');
          nextList = withWord(fileList, word);
          // 之前被排除过的词，现在要加回来。
          nextRemoved = removedList.filter((item) => item !== word);
        } else {
          const active = kind === 'work' ? fresh.workHints : fresh.chatHints;
          if (!active.includes(word)) throw new Error(`词表里没有「${word}」`);
          nextList = fileList.filter((item) => item !== word);
          // 文件里没有、生效规则里却有 → 这个词来自默认或 config，只能记一笔排除。
          nextRemoved = fileList.includes(word) ? removedList : [...removedList, word];
        }

        const next = await writeRulesFile({ ...current, [key]: nextList, removeHints: nextRemoved });
        const after = mergeRules(config, next);
        if (after.log) {
          writeLog({
            ts: new Date().toISOString(),
            session: agent?.id ?? null,
            band: `rule:${action}`,
            reason: kind,
            hits: [word],
            depth: after.depth,
            source: 'subtext_rule',
            text: '',
          });
        }

        return {
          action: action === 'add' ? 'added' : 'removed',
          ok: true,
          message: action === 'add'
            ? `已把「${word}」加进${kind === 'work' ? '工作' : '聊天'}词，下一句消息就按新边界判。`
            : `已把「${word}」从${kind === 'work' ? '工作' : '聊天'}词里去掉。`,
          path: rulesFile,
          enabled: after.enabled,
          depth: after.depth,
          workHints: after.workHints,
          chatHints: after.chatHints,
          leadVerbs: after.leadVerbs,
          recent: [],
        };
      },
      isConcurrencySafe() {
        return false;
      },
    });

  // ---- 插件详情页的编辑接口 ----
  //
  // 浏览器写不了文件，所以给一个最小 RPC：读当前工作语、保存他自己加的那几条。
  // 路由自己挂在 webServer 上：DSH 0.2.2 的 connection.rpc.handle 走的是 service
  // provider 的 ctx，那边拿不到 webServer，直接开会 405。

  /** 同步读文件里的原始 JSON；文件不存在或坏了就当空对象。 */
  const readFileJson = () => {
    try {
      const raw = JSON.parse(readFileSync(rulesFile, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  };

  /** 面板要看到的三份词：他自己加的、内置的、合并后真正生效的。 */
  const view = () => {
    const fileJson = readFileJson();
    const merged = mergeRules(config, fileJson);
    return {
      path: rulesFile,
      enabled: merged.enabled,
      depth: merged.depth,
      builtinActive: merged.builtinActive,
      mine: Array.isArray(fileJson.workHints)
        ? fileJson.workHints.filter((item) => typeof item === 'string')
        : [],
      builtin: [...DEFAULTS.workHints],
      merged: merged.workHints,
      leadVerbs: merged.leadVerbs,
    };
  };

  /** 清洗词表：去空、去重。界面过滤一次，这里再过滤一次，不靠前端自觉。 */
  const cleanWords = (list) => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const word = item.trim();
      if (word === '' || seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
    return out;
  };

  /**
   * RPC 入口。抽成纯函数是为了单测能直接打它，不用起 HTTP。
   *
   * @param {string} endpoint `get` / `save`
   * @param {object} [payload]
   */
  const handleRpc = async (endpoint, payload) => {
    try {
      if (endpoint === 'get') return { ok: true, value: view() };

      if (endpoint === 'save') {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        if (!Array.isArray(body.workHints)) {
          return { ok: false, error: { code: 'subtext/bad-request', message: 'workHints 必须是数组' } };
        }
        const patch = { workHints: cleanWords(body.workHints) };
        if (body.depth !== undefined) {
          const depth = Number(body.depth);
          if (!Number.isFinite(depth) || depth < 1 || depth > 3) {
            return { ok: false, error: { code: 'subtext/bad-request', message: '深度只能是 1、2、3' } };
          }
          patch.depth = Math.trunc(depth);
        }
        const next = await writeRulesFile({ ...readFileJson(), ...patch });
        const after = mergeRules(config, next);
        if (after.log) {
          writeLog({
            ts: new Date().toISOString(),
            session: null,
            band: 'ui:save',
            reason: 'panel',
            hits: patch.workHints,
            depth: after.depth,
            source: 'panel',
            text: '',
          });
        }
        return { ok: true, value: view() };
      }

      return { ok: false, error: { code: 'subtext/unknown-endpoint', message: `unknown endpoint: ${endpoint}` } };
    } catch (error) {
      return { ok: false, error: { code: 'subtext/failed', message: String(error?.message ?? error) } };
    }
  };

  const MAX_BODY_BYTES = 1024 * 1024;
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJsonBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  };

  // 详情页 RPC。webServer 是可选依赖：用 cordis 的 inject 等它就绪再挂路由。
  // 别用 `ctx.get('webServer')` 直接拿——未声明注入的服务取不到，
  // 表现就是路由根本没挂上，外面打进来 405。
  const registrar = typeof ctx.inject === 'function'
    ? (deps, callback) => ctx.inject(deps, callback)
    : typeof ctx.registry?.inject === 'function'
      ? (deps, callback) => ctx.registry.inject(deps, callback)
      : null;

  if (registrar) {
    registrar(['webServer'], (web) => {
      const route = {
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://subtext');
          const prefix = `${RPC_CHANNEL}/`;
          const endpoint = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
          if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
            res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('not found');
            return;
          }
          const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (contentType !== 'application/json') {
            res.writeHead(415, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('content type must be application/json');
            return;
          }
          const envelope = await readJsonBody(req);
          if (envelope === undefined || typeof envelope?.rpcId !== 'string' || typeof envelope?.method !== 'string') {
            res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('invalid rpc envelope');
            return;
          }
          if (envelope.method !== endpoint) {
            sendJson(res, 200, {
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'gateway/bad-request',
                  message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
                },
              },
            });
            return;
          }
          const result = await handleRpc(endpoint, envelope.payload);
          sendJson(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result });
        },
      };
      try {
        web.effect(() => web.webServer.register(route), 'dsh-subtext.rpc()');
      } catch (error) {
        warn(`rpc route registration failed: ${String(error)}`);
      }
    });
  } else {
    warn('no ctx.inject; plugin-detail RPC unavailable on this host');
  }

  /**
   * `subtext_pass`：这一轮的三层打卡。
   *
   * 提示里写死了「开口之前先调它」，`agent/turn-stopping` 那边检查调没调过——
   * 没调就把回合拽回来。这是整个插件里唯一一道真关卡：跳过会卡住，而不是
   * 「不报错照样过」。它拦得住不打卡，拦不住打卡但敷衍，那一层只能靠人抽查。
   */
  const makePassTool = () =>
    defineTool({
      name: PASS_TOOL_NAME,
      description: [
        '记录这一轮对「言外之意」三层的读法。日常对话里开口之前必须调用一次。',
        '按当前档位填：1 层填 feeling；2 层加 need；3 层再加 unsaid、identity、bond。没调它直接回复，回合会被拦下来。',
      ].join('\n'),
      parameters: {
        feeling: {
          type: 'string',
          description: '第一层 · 情感：这句话除了字面还在传什么情感，他期待哪一种回应',
        },
        need: {
          type: 'string',
          description: '第二层 · 此刻的需求：他为什么此时此刻说这一句，想换来什么',
        },
        unsaid: {
          type: 'string',
          description: '第三层 · 说不出口的部分：为什么不直说、难言之隐、台阶在哪',
        },
        identity: {
          type: 'string',
          description: '第三层 · 我是谁：我的身份、我在这段谈话里是什么样的人',
        },
        bond: {
          type: 'string',
          description: '第三层 · 我们是什么关系：到这一步，我们之间攒下了什么；这句话为什么独独对我成立',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'depth'],
          properties: {
            ok: { type: 'boolean' },
            depth: { type: 'number' },
            note: { type: 'string' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.note ?? `已记录（${value.depth} 层）。` }];
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        const state = agent && typeof agent.id === 'string' ? states.get(agent.id) : undefined;
        if (!state) throw new Error('这个会话没有开言外之意的档位，不用打卡');

        const fresh = refreshRules();
        if (!fresh.enabled) return { ok: true, depth: fresh.depth, note: '言外之意已关闭，不记。' };

        const depth = fresh.depth;
        const feeling = String(args?.feeling ?? '').trim();
        const need = String(args?.need ?? '').trim();
        const unsaid = String(args?.unsaid ?? '').trim();
        const identity = String(args?.identity ?? '').trim();
        const bond = String(args?.bond ?? '').trim();

        if (feeling === '') throw new Error('第一层（情感）不能空：这句话在传什么情感');
        if (depth >= 2 && need === '') throw new Error('第二层（需求）不能空：他为什么此刻说这句');
        if (depth >= 3 && unsaid === '') throw new Error('第三层（说不出口的部分）不能空');
        if (depth >= 3 && identity === '') throw new Error('第三层（我是谁）不能空：我的身份、我在这段谈话里是什么样的人');
        if (depth >= 3 && bond === '') throw new Error('第三层（我们是什么关系）不能空：到这一步我们之间攒下了什么');

        state.passed = true;
        if (fresh.log) {
          writeLog({
            ts: new Date().toISOString(),
            session: agent.id,
            band: 'pass',
            reason: 'subtext_pass',
            hits: [],
            depth,
            source: 'tool',
            text: [feeling, need, unsaid, identity, bond].filter((part) => part !== '').join(' | ').slice(0, 400),
          });
        }
        return { ok: true, depth, note: `已记录（${depth} 层）。` };
      },
      isConcurrencySafe() {
        return false;
      },
    });

  const tools = service('tools');
  if (typeof defineTool === 'function' && tools && typeof tools.register === 'function') {
    try {
      ctx.effect(() => tools.register(makeRuleTool()), 'dsh-subtext.rule-tool()');
    } catch (error) {
      warn(`rule tool registration failed: ${String(error)}`);
    }
    try {
      ctx.effect(() => tools.register(makePassTool()), 'dsh-subtext.pass-tool()');
    } catch (error) {
      warn(`pass tool registration failed: ${String(error)}`);
    }
  }

  // 启动时先读一次文件，让第一条消息就用上用户已经写好的边界。
  refreshRules();

  // 热加载时已经有会话在跑，`agent/created` 不会重放，这里补一遍。
  // 冷启动时 roots() 是空的，什么都不做。
  try {
    const roots = service('agents')?.roots?.();
    for (const agent of roots ?? []) {
      if (!agent || typeof agent.id !== 'string' || states.has(agent.id)) continue;
      states.set(agent.id, EMPTY_STATE());
      registerSection(agent);
    }
  } catch {
    // roots() 不可用就算了，等下一个 agent/created
  }
}
