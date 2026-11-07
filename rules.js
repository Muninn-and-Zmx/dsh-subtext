/**
 * 言外之意（dsh-subtext）的规则层。
 *
 * 两件事，都是纯函数，方便单测：
 * 1. 把「内置默认 < patch yml config < 用户文件」三层并成一份有效规则；
 * 2. 按规则把一条消息判成 `work` / `chat`（判不出就返回 null，调用方保持原档）。
 *
 * 判定的姿态：**不追求准，追求可推翻**。这里只按词和开头做初判，真正的分档
 * 交给模型——注入的文案里明说了初判不准可以自己改。程序负责留痕，不负责拍板。
 */

/** 默认工作词：沿用 tools/lang.py 的 WORK_HINTS，再加几个交代活时常见的词。 */
export const DEFAULT_WORK_HINTS = [
  '代码',
  '接口',
  '部署',
  '重启',
  '插件',
  '服务器',
  '配置',
  '配比',
  '测试',
  '版本',
  '安装',
  '卸载',
  '日志',
  '脚本',
  '构建',
  '需求',
  '验收',
  '实现',
  '功能',
];

/**
 * 默认祈使开头。只用多字动词：单字「改」「装」「修」会把「改天再说」
 * 「装修」「修图」一起抓进来，误判比漏判更烦人。
 */
export const DEFAULT_LEAD_VERBS = [
  '检查',
  '查一下',
  '做一下',
  '改一下',
  '修一下',
  '装一下',
  '跑一下',
  '验证',
  '实现',
  '看看这个',
];

/** 只匹配前 200 字：消息再长，开场那句才决定这是不是交代活。 */
export const PROBE_CHARS = 200;

/** 短于这个长度、又以完成态收尾的，按汇报算。 */
export const REPORT_MAX_CHARS = 12;

/** 完成态收尾：了 / 啦 / 好了 / 完了 / 成功 / 完成 / 搞定。 */
export const REPORT_END = /(了|啦|好了|完了|成功|完成|搞定)[。！!…~]*$/;

/**
 * 这是在汇报结果，还是在交代活？
 *
 * 「重启了」「验证完了」「部署成功」——里面都有工作词，可他说的是「我干完了」，
 * 不是「你去干」。这类短汇报按工作档关掉理解层，属于误伤。
 */
export function looksLikeReport(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value !== '' && value.length <= REPORT_MAX_CHARS && REPORT_END.test(value);
}

/** 插件内置默认。patch yml 的 config 与 $DSH_HOME/dsh-subtext.json 都覆盖它。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  depth: 1,
  order: -86,
  scope: 'root',
  workHints: DEFAULT_WORK_HINTS,
  leadVerbs: DEFAULT_LEAD_VERBS,
  chatHints: [],
  log: true,
});

/** 深度只有三档，其余一律夹回范围内。 */
export function clampDepth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.depth;
  return Math.max(1, Math.min(3, Math.trunc(number)));
}

/**
 * 一份字符串数组：去空、去重、保持顺序。非数组直接给空。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const word = item.trim();
    if (word === '' || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * 合并生效规则。标量按 `fileJson` > `config` > `DEFAULTS` 覆盖。
 *
 * 词表分两种语义：
 * - **工作语是接管**：文件里一写 `workHints`，内置工作词和内置祈使动词就整体让位，
 *   只剩他写的算工作。这是 2026-11-08 用户定的「我设了工作语，其余都当日常对话」。
 * - **其余词表是叠加**：`chatHints` 永远并进来（它是纠错口），`removeHints` 只在不接管时有用。
 *
 * @param {object} [config] Loader row config（cordis.patch.yml）
 * @param {object} [fileJson] $DSH_HOME/dsh-subtext.json
 * @returns {object} 完整的有效规则，含 `builtinActive` 表示内置工作语是否还在生效
 */
export function mergeRules(config = {}, fileJson = {}) {
  const conf = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const file = fileJson && typeof fileJson === 'object' && !Array.isArray(fileJson) ? fileJson : {};
  const pick = (key) => {
    if (file[key] !== undefined) return file[key];
    if (conf[key] !== undefined) return conf[key];
    return DEFAULTS[key];
  };

  const order = Number(pick('order'));
  const removed = stringList(pick('removeHints'));

  /** 默认 → config → 文件，去重保序，最后减掉 removeHints。 */
  const stack = (...lists) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const word of stringList(list)) {
        if (seen.has(word)) continue;
        seen.add(word);
        out.push(word);
      }
    }
    return removed.length === 0 ? out : out.filter((word) => !removed.includes(word));
  };

  // 文件里一出现 workHints，就等于接管整个触发清单：内置工作词和内置祈使动词
  // 都不再参与，只剩他自己写的。这是 2026-11-08 用户定的——
  // 「我设了工作语，你有的其他都当作日常对话」。
  // 想保留内置的，就别在文件里写 workHints（或写空数组是「一条都不算」）。
  const fileOwnsWork = Array.isArray(fileJson && fileJson.workHints);

  return {
    enabled: pick('enabled') !== false,
    depth: clampDepth(pick('depth')),
    order: Number.isFinite(order) ? order : DEFAULTS.order,
    scope: pick('scope') === 'all' ? 'all' : 'root',
    builtinActive: !fileOwnsWork,
    workHints: fileOwnsWork
      ? stack(fileJson.workHints)
      : stack(DEFAULTS.workHints, conf.workHints),
    leadVerbs: fileOwnsWork
      ? stack(fileJson.leadVerbs)
      : stack(DEFAULTS.leadVerbs, conf.leadVerbs),
    chatHints: stack(DEFAULTS.chatHints, conf.chatHints, fileJson.chatHints),
    log: pick('log') !== false,
  };
}

/** 消息里的文本块拼起来；图片、附件之类直接忽略。 */
export function extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 只有用户亲手打的消息才切档位。插件注入的（空闲倡议、记忆收尾）source 不是
 * `user`，不参与判定，否则会被当成「他说的话」——那正是最危险的一类误判。
 */
export function isUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  return message?.source?.kind === 'user';
}

/** 给日志用：消息来源的 kind，缺失记 null。 */
export function sourceKind(message) {
  const kind = message?.source?.kind;
  return typeof kind === 'string' ? kind : null;
}

/**
 * 判一条消息属于哪一档。
 *
 * @param {string} rawText
 * @param {object} rules 有效规则（mergeRules 的结果）
 * @returns {{band: 'work' | 'chat' | null, hits: string[], reason: string}}
 *   `band: null` 表示没有文本可判，调用方应保持原档。
 */
export function classify(rawText, rules) {
  const full = typeof rawText === 'string' ? rawText.trim() : '';
  if (full === '') return { band: null, hits: [], reason: 'empty' };

  const probe = full.slice(0, PROBE_CHARS);

  // 他自己标过的聊天词优先：这是纠正误判的唯一出口，权重必须最高。
  const chatWord = rules.chatHints.find((word) => probe.includes(word));
  if (chatWord) return { band: 'chat', hits: [chatWord], reason: 'chat-hint' };

  // 短句加完成态是汇报，不是交代——这一条要压在工作词前面，
  // 否则「重启了」「验证完了」都会因为碰巧含工作词被当成任务。
  if (looksLikeReport(full)) return { band: 'chat', hits: [], reason: 'report' };

  const workHits = rules.workHints.filter((word) => probe.includes(word));
  if (workHits.length > 0) return { band: 'work', hits: workHits, reason: 'work-hint' };

  // 开头就下指令，比正文里提到一个工作词更硬。
  const lead = rules.leadVerbs.find((verb) => full.startsWith(verb));
  if (lead) return { band: 'work', hits: [lead], reason: 'lead-verb' };

  return { band: 'chat', hits: [], reason: 'default' };
}

/**
 * 往规则文件里加一个词（工具用）。返回新数组，不改入参。
 *
 * @param {string[]} list
 * @param {string} word
 */
export function withWord(list, word) {
  const clean = typeof word === 'string' ? word.trim() : '';
  if (clean === '') throw new Error('word 不能为空');
  if (list.includes(clean)) throw new Error(`词表里已经有「${clean}」`);
  return [...list, clean];
}
