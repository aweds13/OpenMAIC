/**
 * 材料库 —— 一个由**智能体自己维护**的文件夹，而不是用户预填的清单。
 *
 * ── 为什么要这一层 ────────────────────────────────────────────────
 *
 * 用户的原话：「我希望他能把他在收集材料的时候能问我哪些要，然后写到材料
 * 清单里面，而不是我提前写好」「他有一个准备工作，就准备材料的工作」「写大纲
 * 的时候还会根据大纲需要什么再去准备一遍，准备好之后写到那个材料清单里面」。
 *
 * 也就是说：材料清单是**产出**，不是**输入**。之前的实现（只读注入一份用户
 * 手写的清单）把方向做反了。
 *
 * ── 为什么是文件夹不是单文件 ──────────────────────────────────────
 *
 * 「不然的话混在一起，到后面那个材料越来越多，不好管理。」
 *
 *   <materialsDir>/
 *     INDEX.md            ← 索引层：有哪些主题、每个一句话。**每次注入**。
 *     dart-flutter.md     ← 主题文件：具体条目。按需读。
 *     java-backend.md
 *
 * 索引层永远短小，所以注入它不会随材料增长而撑爆上下文；主题文件按需读。
 *
 * ── 两个工具 ──────────────────────────────────────────────────────
 *
 *   read_materials(topic?)     不传 topic = 列索引；传 = 读该主题文件
 *   update_materials(...)      写入（append 追加 / replace 覆盖）
 *
 * **路径安全**：topic 被限制成严格的 slug（小写字母数字短横线）或字面量
 * `INDEX`。这样 `../` 之类的穿越在正则层面就不可能 —— 不依赖事后校验。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { agentRuntimeConfig } from './config';
import { readPromptContextFile } from './prompt-context-file';

/** 索引文件名，固定。 */
const INDEX_NAME = 'INDEX';

/**
 * 允许的 topic 形状。
 *
 * 严格到只有小写字母、数字、短横线 —— 于是 `.`、`/`、`\`、`..` 在正则层面
 * 就被排除，**路径穿越不可能发生**，不需要额外的事后校验。
 * 中文主题名请用英文 slug（如 `java-backend`），中文写在文件内容里。
 */
const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 单个主题文件的写入上限，防止一次写入把仓库撑爆。 */
const MAX_WRITE_CHARS = 200_000;

function materialsDir(): string | null {
  return agentRuntimeConfig.materialsDir ?? null;
}

/** topic 字符串 → 绝对路径；非法返回 null。 */
function topicPath(dir: string, topic: string): string | null {
  if (topic === INDEX_NAME) return join(dir, 'INDEX.md');
  if (!TOPIC_SLUG.test(topic)) return null;
  return join(dir, `${topic}.md`);
}

/** 列出文件夹里已有的主题（slug），按名排序。 */
function listTopics(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
      .map((f) => f.slice(0, -3))
      .filter((t) => TOPIC_SLUG.test(t))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 注入用的索引内容：`INDEX.md` 的正文，外加一行**实际存在**的主题文件列表。
 *
 * 为什么要补这一行：`INDEX.md` 是智能体自己维护的，它可能忘了更新索引表。
 * 把磁盘上真实存在的文件列出来，模型就不会"以为"某个主题不存在而重复新建。
 */
/**
 * 材料库里**实际存在的主题**（主题文件名去掉 `.md`）；**没配材料库时返回 `null`**。
 *
 * ★ 存在的理由（一条实测修正）：`update_materials` 写下的是**主题文件**，它
 *   **不返回任何 id** —— `details` 只有 `{ topic, mode, created }`。
 *   所以任何"记一个材料 id 再指过去"的设计都是**空的**：那个 id 从来不存在。
 *   要引用材料库里的东西，唯一真实的单位就是**主题**。
 */
export function listMaterialTopics(): string[] | null {
  const dir = materialsDir();
  if (!dir) return null;
  return listTopics(dir);
}

export function resolveMaterialsIndex(): string | null {
  const dir = materialsDir();
  if (!dir) return null;

  const index = readPromptContextFile(join(dir, 'INDEX.md'));
  const topics = listTopics(dir);

  const onDisk =
    topics.length > 0
      ? `\n\n### 磁盘上实际存在的主题文件\n\n${topics.map((t) => `- \`${t}.md\``).join('\n')}`
      : '';

  // 索引缺失但文件夹里已有主题文件时，也要注入（否则模型完全不知道有材料库）。
  if (!index && !onDisk) return null;
  return `${index ?? '（INDEX.md 尚未创建）'}${onDisk}`;
}

/**
 * 提示词块。
 *
 * 框定语要传达四件事：
 *   1. 这个库是**你维护的**，不是用户手写的；
 *   2. 收集材料前**先问用户要什么**，搜到东西也要问要不要，**不要直接写进去**；
 *   3. 用户说不要的记下来，免得下次再搜一遍；
 *   4. 按主题归档，别把什么都塞进索引。
 */
export function materialsIndexPromptBlock(index: string): string {
  return [
    '## Materials library (you maintain this)',
    '',
    'A folder of material lists that **you** keep up to date — it is not something the learner',
    'wrote for you. Two layers: `INDEX.md` (short: which topics exist) and one file per topic',
    '(the actual entries). Keep the index short; put detail in the topic files.',
    '',
    '**Gather, ask, then record:**',
    '',
    '1. Before planning, ask the learner what materials they want for this subject. They may have',
    '   none in mind — then propose candidates you found with `web_search` and let them choose.',
    '2. Search when the plan needs something. `web_search` finds open-source projects, free books',
    '   and courses; `fetch_url` reads a page to confirm it is what the title claims.',
    '3. **Ask before recording.** Never write a candidate into the library just because you found',
    '   it. Show the learner what you found and what you would use it for, then record only what',
    '   they accept.',
    '4. Record rejections too, in the topic file\'s「明确不要用的」section — so neither of you',
    '   revisits the same dead end.',
    '5. Every entry needs: what it is, its URL, and **what role it plays** (knowledge backbone /',
    '   source of examples / project template). The role matters more than the title — the same',
    '   book used as a backbone and as extra reading produce different courses.',
    '',
    'Tools: `read_materials` (no topic = the index; with a topic = that file) and',
    '`update_materials` (append to a topic, or replace it when creating/rewriting one).',
    'Create a new topic file when a subject has none, and add its row to `INDEX.md`.',
    '',
    '**Do not reconstruct a material\'s contents from its title.** Read it with `fetch_url` first.',
    'If you cannot read it (dead link, login wall), say so — do not quietly substitute your own',
    'knowledge and imply it came from the source.',
    '',
    '---',
    '',
    index,
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────

const READ_PARAMS = Type.Object(
  {
    topic: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'Topic slug (e.g. "dart-flutter"), or "INDEX" for the index itself. ' +
          'Omit to list every topic in the library.',
      }),
    ),
  },
  { additionalProperties: false },
);

const UPDATE_PARAMS = Type.Object(
  {
    topic: Type.String({
      minLength: 1,
      maxLength: 64,
      description: 'Topic slug (e.g. "dart-flutter") or "INDEX". Lowercase letters, digits and dashes only.',
    }),
    content: Type.String({
      minLength: 1,
      description: 'Full Markdown body to write. For append mode this is the block to add at the end.',
    }),
    mode: Type.Union([Type.Literal('append'), Type.Literal('replace')], {
      description:
        'append = add the block at the end (use when adding entries to an existing topic). ' +
        'replace = overwrite the file (use when creating a topic or rewriting the index).',
    }),
  },
  { additionalProperties: false },
);

/** `read_materials` —— 列索引或读某个主题。 */
export function buildReadMaterialsTool(): AgentTool<never, never> {
  return {
    name: 'read_materials',
    label: 'Read the materials library',
    description:
      'Read the learner\'s materials library. With no `topic`, lists the index plus every topic ' +
      'file that exists on disk. With a `topic`, returns that file. Use it before planning so you ' +
      'reuse materials already agreed on instead of searching for them again.',
    parameters: READ_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof READ_PARAMS>) {
      const dir = materialsDir();
      if (!dir) {
        return {
          content: [{ type: 'text' as const, text: 'The materials library is not configured.' }],
          isError: true,
        };
      }

      if (!params.topic) {
        const topics = listTopics(dir);
        const index = readPromptContextFile(join(dir, 'INDEX.md')) ?? '（INDEX.md 尚未创建）';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${index}\n\n### Topics on disk\n\n${
                topics.length ? topics.map((t) => `- ${t}`).join('\n') : '(none yet)'
              }`,
            },
          ],
          details: { topics },
        };
      }

      const path = topicPath(dir, params.topic);
      if (!path) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid topic "${params.topic}". Use a lowercase slug (letters, digits, dashes) or "INDEX".`,
            },
          ],
          isError: true,
        };
      }
      if (!existsSync(path)) {
        const topics = listTopics(dir);
        return {
          content: [
            {
              type: 'text' as const,
              text: `No topic "${params.topic}" yet. Existing topics: ${
                topics.length ? topics.join(', ') : '(none)'
              }. Create it with update_materials.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: readFileSync(path, 'utf8') }],
        details: { topic: params.topic },
      };
    },
  } as unknown as AgentTool<never, never>;
}

/** `update_materials` —— 写入材料库。 */
export function buildUpdateMaterialsTool(): AgentTool<never, never> {
  return {
    name: 'update_materials',
    label: 'Update the materials library',
    description:
      'Write to the learner\'s materials library. Call it only for materials the learner has ' +
      '**accepted** — never record a candidate you merely found. `append` adds a block to a topic ' +
      'file; `replace` overwrites it (use when creating a new topic or rewriting INDEX.md). ' +
      'After adding a new topic, add its row to INDEX.md too.',
    parameters: UPDATE_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof UPDATE_PARAMS>) {
      const dir = materialsDir();
      if (!dir) {
        return {
          content: [{ type: 'text' as const, text: 'The materials library is not configured.' }],
          isError: true,
        };
      }
      const path = topicPath(dir, params.topic);
      if (!path) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid topic "${params.topic}". Lowercase letters, digits and dashes only, or "INDEX".`,
            },
          ],
          isError: true,
        };
      }
      if (params.content.length > MAX_WRITE_CHARS) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Refused: ${params.content.length} characters exceeds the ${MAX_WRITE_CHARS} limit. Write a summary instead of pasting the whole source.`,
            },
          ],
          isError: true,
        };
      }

      try {
        mkdirSync(dir, { recursive: true });
        const existed = existsSync(path);
        // 归一化尾部空白：否则 replace 一份本就以换行结尾的内容会多出一个空行，
        // 每次重写都长一点。
        const block = params.content.replace(/\s+$/, '');
        const body =
          params.mode === 'append' && existed
            ? `${readFileSync(path, 'utf8').replace(/\s+$/, '')}\n\n${block}\n`
            : `${block}\n`;
        writeFileSync(path, body, 'utf8');
        return {
          content: [
            {
              type: 'text' as const,
              text: `${existed ? 'Updated' : 'Created'} ${params.topic}.md (${params.mode}).`,
            },
          ],
          details: { topic: params.topic, mode: params.mode, created: !existed },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not write ${params.topic}.md: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  } as unknown as AgentTool<never, never>;
}

/** 这一层注册的工具名。runner 的 allowlist 跟着它走。 */
export const MATERIALS_TOOL_NAMES = ['read_materials', 'update_materials'] as const;
