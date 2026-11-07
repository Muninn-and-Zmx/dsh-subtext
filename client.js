/**
 * 言外之意的浏览器半：只做一件事——在「设置 → 插件 → 言外之意」的详情页里
 * 放一块「工作语」编辑区。
 *
 * 筛页面：`plugins.detail.section` 是全局列表，每个插件详情页都会渲染它，
 * 所以组件先看 `subject.pkg.name`，不是自己就返回 null，绝不往别人的页面里塞东西。
 *
 * 存哪里：All 走 host 的 RPC，浏览器不碰文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subtext',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PKG = 'dsh-subtext';
    const SLOT = 'plugins.detail.section';
    const CHANNEL = '/dsh-subtext';
    const TIMEOUT_MS = 10000;

    const STYLE = `
.st-panel { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 10px; border: 1px solid rgba(128, 128, 128, .25); }
.st-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.st-title { font-size: 13px; font-weight: 600; margin: 0; }
.st-sub { font-size: 12px; opacity: .62; line-height: 1.45; }
.st-add { display: flex; gap: 8px; }
.st-input {
  flex: 1; min-width: 0; box-sizing: border-box; color: inherit; font: inherit; font-size: 13px;
  padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .38);
  background: rgba(128, 128, 128, .07); outline: none;
}
.st-input:focus { border-color: rgba(77, 107, 254, .75); }
.st-button {
  font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(128, 128, 128, .38); background: transparent; color: inherit;
}
.st-button:disabled { opacity: .5; cursor: default; }
.st-primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.st-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.st-chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
  padding: 4px 6px 4px 10px; border-radius: 999px; border: 1px solid rgba(128, 128, 128, .38);
}
.st-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; opacity: .6; padding: 0 2px; }
.st-chip button:hover { opacity: 1; }
.st-empty { font-size: 12.5px; opacity: .6; }
.st-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.st-status { font-size: 12.5px; opacity: .8; }
.st-error { color: #e5484d; opacity: 1; }
.st-ok { color: #2f9e44; opacity: 1; }
.st-note { margin: 0; font-size: 11.5px; opacity: .6; word-break: break-all; line-height: 1.5; }
.st-field { display: flex; flex-direction: column; gap: 6px; }
.st-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.st-label { font-size: 13px; font-weight: 500; opacity: .88; }
.st-seg { display: inline-flex; border: 1px solid rgba(128, 128, 128, .38); border-radius: 8px; overflow: hidden; }
.st-seg-btn {
  font: inherit; font-size: 13px; padding: 6px 14px; cursor: pointer; color: inherit;
  border: 0; border-right: 1px solid rgba(128, 128, 128, .38); background: transparent;
}
.st-seg-btn:last-child { border-right: 0; }
.st-seg-btn:hover { background: rgba(128, 128, 128, .1); }
.st-seg-active { background: #4d6bfe; color: #fff; }
.st-seg-active:hover { background: #4d6bfe; }
.st-hint { margin: 0; font-size: 12px; opacity: .62; line-height: 1.5; }
`;

    /** 三个档位各自读到哪儿。 */
    const DEPTH_HINT = {
      1: '只读情感：这句话除了字面，还在传什么情绪。',
      2: '在情感之上，再读此刻的需求：这句话想换来什么。',
      3: '再加说不出口的部分：为什么不直说；以及此刻的身份、我们是什么关系、这句话为什么是对我说的。',
    };

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }

    /**
     * @param {{ call: (endpoint: string, payload?: object) => Promise<any> }} face
     */
    function makePanel(face) {
      const { call } = face;

      return function SubtextDetailPanel() {
        const [data, setData] = useState(null);
        const [words, setWords] = useState([]);
        const [depth, setDepth] = useState(1);
        const [draft, setDraft] = useState('');
        const [status, setStatus] = useState({ kind: 'loading', text: '正在读取…' });
        const [saving, setSaving] = useState(false);

        const adopt = (value) => {
          setData(value);
          setWords(value.mine);
          setDepth(value.depth);
          setStatus({ kind: 'idle', text: '' });
        };

        const load = useCallback(async () => {
          try {
            adopt(await call('get', {}));
          } catch (error) {
            setStatus({ kind: 'error', text: `读不到设置：${messageOf(error)}` });
          }
        }, [call]);

        useEffect(() => {
          load();
        }, [load]);

        const add = () => {
          const word = draft.trim();
          if (word === '') return;
          if (words.includes(word)) {
            setStatus({ kind: 'error', text: `「${word}」已经在列表里了` });
            return;
          }
          setWords([...words, word]);
          setDraft('');
          setStatus({ kind: 'idle', text: '' });
        };

        const remove = (word) => {
          setWords(words.filter((item) => item !== word));
          setStatus({ kind: 'idle', text: '' });
        };

        const save = async () => {
          setSaving(true);
          try {
            adopt(await call('save', { workHints: words, depth }));
            setStatus({ kind: 'ok', text: '已保存，下一句消息就按新设置走。' });
          } catch (error) {
            setStatus({ kind: 'error', text: `保存失败：${messageOf(error)}` });
          } finally {
            setSaving(false);
          }
        };

        if (data === null) {
          return h('div', { className: 'st-panel' }, h('p', { className: status.kind === 'error' ? 'st-status st-error' : 'st-status' }, status.text));
        }

        return h(
          'div',
          { className: 'st-panel' },
          h(
            'div',
            { className: 'st-head' },
            h('h4', { className: 'st-title' }, '言外之意'),
            h('span', { className: 'st-sub' }, '日常对话里读字面底下那一层；进了工作就暂停。'),
          ),
          h(
            'div',
            { className: 'st-field' },
            h(
              'div',
              { className: 'st-row' },
              h('span', { className: 'st-label' }, '理解档位'),
              h(
                'div',
                { className: 'st-seg' },
                ...[1, 2, 3].map((n) =>
                  h(
                    'button',
                    {
                      key: n,
                      type: 'button',
                      className: `st-seg-btn${depth === n ? ' st-seg-active' : ''}`,
                      onClick: () => setDepth(n),
                    },
                    `${n} 层`,
                  ),
                ),
              ),
            ),
            h('p', { className: 'st-hint' }, DEPTH_HINT[depth]),
          ),
          h(
            'div',
            { className: 'st-head' },
            h('h4', { className: 'st-title' }, '工作语'),
            h('span', { className: 'st-sub' }, '命中就切工作档、停掉理解。这里一旦有词，内置那些就全部让位。'),
          ),
          h(
            'div',
            { className: 'st-add' },
            h('input', {
              className: 'st-input',
              type: 'text',
              value: draft,
              placeholder: '输入一个词，回车添加',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                }
              },
            }),
            h('button', { className: 'st-button', type: 'button', onClick: add }, '添加'),
          ),
          words.length === 0
            ? h('span', { className: 'st-empty' }, '现在是空的：保存空表就等于连内置的也不用，所有话都当日常对话。')
            : h(
              'div',
              { className: 'st-chips' },
              ...words.map((word) =>
                h(
                  'span',
                  { className: 'st-chip', key: word },
                  word,
                  h('button', { type: 'button', title: `移除「${word}」`, onClick: () => remove(word) }, '×'),
                ),
              ),
            ),
          h(
            'div',
            { className: 'st-actions' },
            h(
              'button',
              { className: 'st-button st-primary', type: 'button', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存',
            ),
            status.text === ''
              ? null
              : h(
                'span',
                {
                  className:
                    status.kind === 'error'
                      ? 'st-status st-error'
                      : status.kind === 'ok'
                        ? 'st-status st-ok'
                        : 'st-status',
                },
                status.text,
              ),
          ),
          h('p', { className: 'st-note' }, '保存后下一句消息生效，不需要重启。'),
          h(
            'p',
            { className: 'st-note' },
            data.builtinActive
              ? `内置工作语（当前生效）：${data.builtin.join('、') || '(空)'}`
              : '内置工作语已停用：现在只按你设的判，其余都当日常对话。',
          ),
          h('p', { className: 'st-note' }, '作者：穆宁 · 烛梦曦'),
          h('p', { className: 'st-note' }, `文件：${data.path}`),
        );
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = PKG;
          style.textContent = STYLE;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-subtext.style()');

        let connection;
        try {
          connection = ctx.get('connection');
        } catch {
          connection = undefined;
        }

        const call = async (endpoint, payload) => {
          if (connection?.rpc?.call === undefined) throw new Error('连不上 Host，暂时不能保存');
          const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {}, AbortSignal.timeout(TIMEOUT_MS));
          if (result?.ok !== true) throw new Error(result?.error?.message ?? 'Host 调用失败');
          return result.value;
        };

        const Panel = makePanel({ call });

        // 只在自己的详情页出现。bundle 页的 subject 是 { kind:'bundle', pkg:{ name } }，
        // row 页也带着 pkg，所以两个入口都能看到同一份配置。
        const Entry = (props) => {
          if (props?.subject?.pkg?.name !== PKG) return null;
          return h(Panel, null);
        };

        // 没装 plugin-manager 的宿主没有这个槽位；面板缺席，宿主其余部分照常。
        try {
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              { name: SLOT, id: PKG, order: 100, label: '工作语' },
              Entry,
            ),
          );
        } catch (error) {
          console.warn('[dsh-subtext] detail panel unavailable:', error);
        }
      },
    };
  },
});
