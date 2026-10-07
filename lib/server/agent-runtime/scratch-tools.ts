/**
 * 草稿纸的**存储 + 工具 + 提示词块** —— 让 `lib/scratch/scratchpad.ts` 真的能被用到。
 *
 * ── 为什么要有这一层（用户的原话）────────────────────────────────
 *
 * 「我认为它注意力有限，需要一个类似草稿纸的方式，帮它记录，然后通知他，并且这个记录
 *   可以把临时的与可复用信息区分，和我们的材料库联动，同时它往里写时也要写编号」
 *
 * `lib/scratch/scratchpad.ts` 里那套纯逻辑（编号 `s001`、两层、索引、可算的
 * "只有 1 个来源"）早就写好并测过（22 条），但**生产代码零引用 ⇒ 死代码**。
 * 这个文件就是把它接上：一个 `scratch` 工具 + 一句恒定提示词。
 *
 * ── 它治的病 ───────────────────────────────────────────────────
 *
 * 实测：一个真会话生成第一页之前做了 59 次对外取证，但没有任何地方写下"这份有用 /
 * 这份跟前面矛盾 / 这条我打算写进课里"。**判断没有落点**，压缩一次就没了。
 *
 * ── 与材料库的边界（**这条不能越**）────────────────────────────
 *
 * 材料库的规矩（提示词原文）：「只收**用户确认要用的**材料。搜到但没确认的，
 * **先问，不要直接写进来**。」
 *
 * 所以本工具**不写材料库**。它只做两件事：
 *   · `promote` **记下指针**（`materialId`）—— 那个 id 只能来自**已经**走完
 *     `update_materials` 的条目，也就是用户已经点头的；
 *   · 搜到但还没被确认的候选，**留在这张纸上**（这正是原本没有落点的那一堆）。
 * 换句话说：草稿纸是材料库的**候场区**，不是第二份材料库。
 *
 * ── 通知走工具结果，不走系统提示词（硬约束）──────────────────
 *
 * 系统提示词一次运行只读一次，而草稿纸中途一直在变 ⇒ 它没法用提示词通知；而且每变一次
 * 整个前缀缓存就废（AGENTS.md §1.2）。所以：提示词里只有**一句恒定的话**，
 * **每次写/读都把当前索引原样还给它**（`write` 的结果里就带全貌）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  addScratchItem,
  classifyScratchItem,
  formatScratchIndex,
  formatScratchReminder,
  markScratchPromoted,
  normalizeScratchpad,
  pruneScratchpad,
  searchScratchItems,
  type ScratchDepth,
  type ScratchKind,
  type Scratchpad,
  type ScratchStatus,
} from '@/lib/scratch/scratchpad';

export const SCRATCH_TOOL_NAMES = ['scratch'] as const;

// ─────────────────────────────────────────────────────────────────
// 文件层
// ─────────────────────────────────────────────────────────────────

/**
 * 放 `data/scratchpad/` —— 应用数据目录。
 *
 * **不是** `个人数据\`（那里只放学习成长的东西，用户明确纠正过，见 §6.8）；
 * **不是** `_tools\openmaic\diagnostics\`（那里放 harness 的调试产物）。
 * 草稿纸是**应用状态**，与 `data/plan-freeze/`（阶段冻结）同级。
 */
export function scratchpadDir(): string {
  return process.env.OPENMAIC_SCRATCHPAD_DIR ?? join(process.cwd(), 'data', 'scratchpad');
}

/** owner 级一份。ownerId 只用来拼文件名，所以做白名单替换，免得路径被带出去。 */
export function scratchpadFile(ownerId: string): string {
  const safe = ownerId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  return join(scratchpadDir(), `${safe}.json`);
}

/** 读。文件没有 / 坏了 ⇒ 归一化成空草稿纸，**不抛**。 */
export async function readScratchpad(ownerId: string): Promise<Scratchpad> {
  try {
    const text = await readFile(scratchpadFile(ownerId), 'utf8');
    return normalizeScratchpad(JSON.parse(text));
  } catch {
    return normalizeScratchpad(null);
  }
}

/** 原子写（tmp + rename，同目录 rename 在 Windows 上也是原子的）。 */
export async function writeScratchpad(ownerId: string, pad: Scratchpad): Promise<boolean> {
  const path = scratchpadFile(ownerId);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(pad, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────

const SCRATCH_PARAMS = Type.Object({
  action: Type.Union(
    [
      Type.Literal('write'),
      Type.Literal('index'),
      Type.Literal('search'),
      Type.Literal('classify'),
      Type.Literal('promote'),
    ],
    {
      description:
        'write = record one thing you read or concluded (returns its id); index = the whole ' +
        'scratchpad; search = filter it; classify = your judgement on an item (keep / drop); ' +
        'promote = record the pointer of an item that became a materials-library entry.',
    },
  ),
  kind: Type.Optional(
    Type.Union(
      [Type.Literal('source'), Type.Literal('claim'), Type.Literal('todo'), Type.Literal('note')],
      {
        description:
          'For `write`. `source` = something you read (give source, and depth: skim or deep); ' +
          '`claim` = a fact you intend to put in the course (give the source ids that back it); ' +
          '`todo`/`note` = anything else.',
      },
    ),
  ),
  text: Type.Optional(Type.String({ description: 'For `write`: one line. Keep it short.' })),
  source: Type.Optional(Type.String({ description: 'For `write` with kind=source: URL or materialId.' })),
  depth: Type.Optional(
    Type.Union([Type.Literal('skim'), Type.Literal('deep')], {
      description: 'For `write` with kind=source: did you skim it or read it properly?',
    }),
  ),
  sources: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'For `write` with kind=claim: the ids of the source items that back this claim. ' +
        'A claim with fewer than two is reported back to you — find a second source or do not write it.',
    }),
  ),
  conflictWith: Type.Optional(
    Type.String({ description: 'For `write`: the id this item contradicts. Contradictions must surface.' }),
  ),
  id: Type.Optional(Type.String({ description: 'For `classify` / `promote`: the item id (e.g. s003).' })),
  status: Type.Optional(
    Type.Union([Type.Literal('kept'), Type.Literal('dropped')], {
      description: 'For `classify`: kept = still relevant; dropped = judged useless.',
    }),
  ),
  materialId: Type.Optional(
    Type.String({
      description:
        'For `promote`: the id `update_materials` returned. Only pass this **after** the learner ' +
        'accepted the material — the library rule is "record only what they accepted".',
    }),
  ),
  query: Type.Optional(Type.String({ description: 'For `search`: substring over text/source/id.' })),
  sessionId: Type.Optional(Type.String({ description: 'Who wrote it. Pass the current session id.' })),
});

export interface ScratchToolDeps {
  ownerId: string;
}

export function buildScratchTool(
  deps: ScratchToolDeps,
): AgentTool<typeof SCRATCH_PARAMS, unknown> {
  return {
    name: 'scratch',
    label: 'Scratchpad',
    description:
      'Your working memory for one course. **Write here instead of holding things in your head**: ' +
      'what you read (`source`), what you intend to put in the course (`claim`, with the source ids ' +
      'that back it), and loose todos. Then classify each item — that judgement is the point; an ' +
      'unclassified item is an owed decision and is reported back to you. `promote` only records a ' +
      'pointer to a materials-library entry that is **already recorded** (the learner accepted it); ' +
      'never write to the library from here. Candidates you merely found stay on this paper until ' +
      'the learner accepts them — that is exactly what this paper is for. Every item gets a short ' +
      'stable id (s001…), never reused; refer to items by id, never as "that thing I read".',
    parameters: SCRATCH_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof SCRATCH_PARAMS>) {
      const pad = await readScratchpad(deps.ownerId);

      /** 写/改之后统一回读全貌 —— 这就是"通知"。 */
      const renderBack = async (next: Scratchpad, head: string) => {
        const written = await writeScratchpad(deps.ownerId, next);
        if (!written) {
          return {
            content: [
              { type: 'text' as const, text: '草稿纸没能写盘 —— 这一条没有记下。' },
            ],
            details: {},
            isError: true,
          };
        }
        const reminder = formatScratchReminder(next);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${head}\n\n${formatScratchIndex(next)}${reminder ? `\n\n${reminder}` : ''}`,
            },
          ],
          details: {
            items: next.items.length,
            open: next.items.filter((item) => item.status === 'open').length,
          },
        };
      };

      if (params.action === 'index') {
        const reminder = formatScratchReminder(pad);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${formatScratchIndex(pad)}${reminder ? `\n\n${reminder}` : ''}`,
            },
          ],
          details: { items: pad.items.length },
        };
      }

      if (params.action === 'search') {
        const hits = searchScratchItems(pad, params.query ?? '');
        return {
          content: [
            {
              type: 'text' as const,
              text: hits.length
                ? hits
                    .map((item) => `${item.id} | ${item.kind} | ${item.text}${item.source ? ` ⟨${item.source}⟩` : ''}`)
                    .join('\n')
                : `草稿纸里没有匹配「${params.query ?? ''}」的条目（共 ${pad.items.length} 条）。`,
            },
          ],
          details: { hits: hits.length },
        };
      }

      if (params.action === 'write') {
        const text = (params.text ?? '').trim();
        if (!text) {
          return {
            content: [
              { type: 'text' as const, text: 'write 需要 text（一句话）。' },
            ],
            details: {},
            isError: true,
          };
        }
        const kind: ScratchKind = params.kind ?? 'note';
        // 顺手裁掉早就丢掉的条目（只裁 dropped 且过期的 —— 未判断的和已升级的都不动）。
        const pruned = pruneScratchpad(pad, { now: Date.now() });
        const { pad: next, item } = addScratchItem(pruned, {
          kind,
          text,
          createdAt: Date.now(),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(params.depth ? { depth: params.depth as ScratchDepth } : {}),
          ...(params.sources?.length ? { sources: params.sources } : {}),
          ...(params.conflictWith ? { conflictWith: params.conflictWith } : {}),
        });
        const extra =
          kind === 'claim' && (item.sources?.length ?? 0) < 2
            ? `\n★ ${item.id} 这条说法目前只有 ${item.sources?.length ?? 0} 个来源 —— 再找一个来源，` +
              '或者别把它写进课里。'
            : '';
        return renderBack(next, `记下了 **${item.id}**（${kind}）：${item.text}${extra}`);
      }

      // classify / promote 都需要 id
      const id = (params.id ?? '').trim();
      if (!id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${params.action} 需要 id。先用 action:"index" 看有哪些条目。`,
            },
          ],
          details: {},
          isError: true,
        };
      }
      if (!pad.items.some((item) => item.id === id)) {
        const known = pad.items.slice(0, 20).map((item) => item.id).join(',');
        return {
          content: [
            {
              type: 'text' as const,
              text: `草稿纸里没有 ${id}。现有条目号：${known || '（空）'}。`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      if (params.action === 'classify') {
        const status: Exclude<ScratchStatus, 'promoted'> = params.status ?? 'kept';
        const next = classifyScratchItem(pad, id, status);
        return renderBack(next, `${id} → ${status === 'dropped' ? '已弃' : '留着待定'}。`);
      }

      // promote
      const materialId = (params.materialId ?? '').trim();
      if (!materialId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'promote 需要 materialId —— 那是 `update_materials` 写完之后返回的 id。' +
                '**材料库的规矩是只收用户确认要用的**：所以先把这条给学习者看、等他点头、' +
                '写完材料库、拿到 id，再回来 promote 记指针。找不到的话就让它先留在草稿纸上。',
            },
          ],
          details: {},
          isError: true,
        };
      }
      const next = markScratchPromoted(pad, id, materialId);
      return renderBack(next, `${id} → 已进材料库（${materialId}）。这张纸上只留指针。`);
    },
  };
}

/**
 * 系统提示词里的那一句 —— **无参、恒定**（§1.2 前缀缓存）。
 *
 * 状态与条目一律走工具结果，这里只说"有这张纸、它是干什么的、怎么用"。
 */
export function scratchPromptBlock(): string {
  return [
    '## You have a scratchpad — use it instead of remembering',
    '',
    'Your context is finite and gets compacted. Anything you read, conclude, or intend to do belongs',
    'on the scratchpad (`scratch`), not in your head.',
    '',
    '- `scratch { action: "write", kind: "source", text, source, depth }` — a page you read, and',
    '  whether you skimmed it or read it properly. Record the judgement, not just the URL.',
    '- `scratch { action: "write", kind: "claim", text, sources: ["s001", "s004"] }` — a fact you',
    '  intend to put in the course, together with the source items that back it. **One source is not',
    '  verification**: the tool reports back any claim with fewer than two, and that is the point.',
    '- `scratch { action: "classify", id, status: "kept" | "dropped" }` — this judgement is the',
    '  reason the scratchpad exists. An unclassified item is an owed decision and is reported back.',
    '- `scratch { action: "promote", id, materialId }` — **only** records a pointer to a materials',
    '  entry that already exists, i.e. one the learner accepted. Candidates you merely found stay',
    '  here until then; never write to the materials library from the scratchpad.',
    '',
    'Items get short stable ids (`s001`…), never reused. **Refer to items by id** — "the thing I read',
    'earlier" is not a reference.',
  ].join('\n');
}
