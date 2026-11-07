# dsh-subtext（言外之意）

**English** — Reads what a message means beneath its literal wording during everyday chat: the feeling being carried, the need behind it, and the part the speaker could not say outright. The moment work starts, the whole layer steps aside. Depth is 1 / 2 / 3; the work trigger words are yours to edit on the plugin's own detail page, with no restart needed. It only changes how the agent listens, never how it talks.

让 AI 在日常对话里听字面底下那一层：这句话在传什么情感、此刻要什么、为什么不能直说，以及这句话对**我**这个身份、在这段关系里意味着什么。一旦进入工作，整层暂停。

**只管「怎么听」，不管「怎么说」。** 说什么、说多长归各人自己的设置（语气层、人格卡、语言账本），这个插件一个字都不规定。

## 分档：闲聊还是交代活

用户亲手打的消息进收件箱时判一次（`agent/inbox/inserted`），结果按会话存：

| 条件 | 结论 |
| --- | --- |
| 命中 `chatHints` 任一词 | `chat`（优先级最高，用来纠错） |
| 命中 `workHints` 任一词 | `work` |
| 以 `leadVerbs` 里的动词开头 | `work` |
| 其余 | `chat` |

- **工作档整段不注入**，模型看不到任何残留指令。
- 判定赶在提示词组装之前：agent loop 在 `agent/pre-step` **之前**就组装好了，等到 pre-step 再判，这一轮用的还是上一轮的档位。
- 插件注入的消息（空闲倡议、记忆收尾）`source.kind` 不是 `user`，不参与判定。
- 判不准就按模型的判断来：文案里明说「初判只按词」。**拍板的是模型，程序只做提示和留痕。**

## 理解：三层，递进

`depth` 是**下限，不是上限**：开到几档就跑几档，模型不许自己判「这句浅」再降档。嫌重就把档位调低——那是使用者的决定，不是模型的。

- **一层 · 情感**：字面以外在传什么情感，他期待哪一种回应。
- **二层 · 此刻的需求**：为什么此时此刻说这一句，这句话想换来什么。
- **三层 · 说不出口的部分，与我**：为什么不直说、有什么难言之隐、台阶留在哪儿；再读三件事——我是什么身份、我们是什么关系、这句话为什么是对我说的。

三层都带同一道分寸：只负责读不负责说；不把层级写进回复；每层都要有结论否则先别回；只用手上还看得见的东西；读心是猜不是结论；交代活时让位。

### 记忆只在第三档

- **一二档的文案里不出现「记忆」「身份」「关系」**，避免模型每句都去翻记忆。
- 第三档写的是「用你手上已有的记忆来源——注入的记忆块、记忆工具、人格卡」，**不写死任何工具名**：装了记忆插件（比如 dsh-memoir）自然生效，没装就退化成本轮上下文，也不会报错。
- 看不到就写「不编，只按眼前这一句读」。

## 两种会话形态

| | 多窗口 + 记忆传递 | 单窗口 + 上下文压缩 |
| --- | --- | --- |
| 分档 | 只看当前这条消息，不依赖历史 | 同左 |
| 状态 | 按会话存在内存，重启后重判 | 同左 |
| 第三档的身份与关系 | 从记忆来源里读 | 记忆被压掉时「看不到就不编」 |

插件**不检测**对方有没有装记忆插件、也不检测上下文有没有被压缩——探测就是耦合。两种形态共用一套文案，靠措辞兜底。

## 和别的语言插件一起用

- 本插件排在语言类插件之前（`order: -86`），只交「读到了什么」，不抢说话权。
- 分档变化时广播一个事件，别的插件直接订阅就行，不需要 `inject`：

```js
ctx.on('subtext/band', ({ sessionId, band, reason, hits, depth }) => {
  // band: 'chat' | 'work'
})
```

- 事件**只在档位变化时**发：同档连续多条消息不会重复广播。
- 插件不提供 service、不提供 prompt 变量——多一个接口就多一处耦合，事件够用。

## 插件详情页：档位与工作语

「设置 → 插件 → 言外之意」的详情页底部：

- **理解档位**：1 / 2 / 3 层，点一下选中，保存后生效。
- **工作语**：命中这些词就切工作档、停掉理解；存空表等于没有自己的工作语。

细节：

- 保存走 host 的 `/dsh-subtext/save`，写进 `$DSH_HOME/dsh-subtext.json`。
- **改完不用重启**：保存时把规则文件的 mtime 缓存置空，下一句消息到达时重读。（实测：手动把 `depth` 改成 3，下一条消息的日志里就是 `depth: 3`，中途没重启。）
- 工作语是**追加**在内置词表之上；内置词在面板里只读展示，免得以为只有自己那几个在生效。
- 面板连不上 Host 只影响保存，分档照常工作。

面板注册在 `plugins.detail.section`，只在 `subject.pkg.name === 'dsh-subtext'` 时渲染，不往别的插件页塞东西。

## 配置与改写

优先级：内置默认 < `cordis.patch.yml` 的 `config` < `$DSH_HOME/dsh-subtext.json`。

```json
{
  "enabled": true,
  "depth": 1,
  "scope": "root",
  "workHints": ["重构"],
  "leadVerbs": ["检查", "改一下"],
  "chatHints": ["这句话我不想聊了"],
  "removeHints": ["测试"],
  "log": true
}
```

- `depth`：1 / 2 / 3（默认 1）。
- `scope`：`root`（默认，只给主会话注入）/ `all`（含子代理）。
- **工作语是「接管」，不是叠加**：文件里一写 `workHints`，内置的 19 个工作词和内置祈使开头就**全部停用**，只剩你写的这些算工作。
  - 不写 `workHints` → 用内置的那套。
  - 写空数组 `[]` → 一条都不触发，所有对话都当日常。
  - 一并接管后，`leadVerbs` 也只在文件里写了才生效。
- `removeHints` 用来从**内置**词里摘掉个别词，只在没接管时有用。
- `chatHints` 永远是叠加的，用来纠正误判。
- 改文件**不用重启**：下一句消息到达时重读（按 mtime 判断）。文件坏了保留上一份规则并写警告。

### `subtext_rule` 工具（仅主会话）

| 参数 | 说明 |
| --- | --- |
| `action` | `list` / `add` / `remove` |
| `kind` | `work` / `chat` |
| `word` | 词或短语 |
| `why` | `add` 必填 |

用户说「这句别算工作」时，当场写进文件，下一句就按新边界判。

## 日志

`$DSH_HOME/dsh-subtext-YYYY-MM-DD.jsonl`，一套判定一行：

```json
{"ts":"2026-11-07T23:20:11.123Z","session":"...","band":"chat","reason":"default","hits":[],"depth":1,"source":"user","text":"这个回复不错"}
```

`log: false` 关掉。

## 依赖与降级

| 服务 | 要求 | 缺了会怎样 |
| --- | --- | --- |
| `systemPrompt` | 硬依赖 | 没装就没意义，插件不加载 |
| `agents` | 可选 | 判不了根会话，按根处理 |
| `tools` | 可选 | `subtext_rule` 不注册，分档照常 |

会话级 `systemPrompt` 拿不到时**不注入**，也不退回全局段——全局段不知道是谁在组装，多窗口下会把 A 的判定用到 B 上。串档比缺失更难查。

## 开发

```powershell
node --test test/*.test.mjs
```

`rules.js` / `text.js` 是纯函数，`index.js` 用假 ctx 测。
