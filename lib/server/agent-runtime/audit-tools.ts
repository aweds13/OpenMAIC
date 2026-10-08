/**
 * 课程审计的**工具** —— 让 `lib/quiz/course-audit.ts` 真的能被调到。
 *
 * ── 为什么必须有这个文件 ────────────────────────────────────────
 *
 * 审计的判据（承接率 + 超载）早就写好了，也拿 7 门真实课程标定过，但**只有 live 用例
 * 能跑它** —— 生产代码里没有任何东西 import 它 ⇒ **死代码**。
 * 而"修一门已有课程"恰恰需要它：先审出问题页，才知道该拆哪一页。
 *
 * ── 它为什么需要是工具而不是自动诊断 ─────────────────────────────
 *
 * 写入后诊断（`scene-diagnostics.ts`）挂在**写一页**的时刻，只能看到"这一页周围"。
 * 审计看的是**整门课的相互关系**（这一页用的词有多少是前面建立过的、哪几页超载），
 * 所以它的调用时机是"我要开始修这门课了"，而不是"我刚写了一页"。
 *
 * ── 纯只读 ────────────────────────────────────────────────────
 *
 * 不改任何东西、不回滚、不删页。它只交证据，修法仍然只允许「补 / 挪 / 拆 / 改写」。
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { auditCourse, formatCourseAudit } from '@/lib/quiz/course-audit';
import { readAcceptedReadings, writeAcceptedReadings } from './plan-freeze-store';
import type { Scene } from '@/lib/types/stage';

export const AUDIT_TOOL_NAMES = ['course_audit'] as const;

const AUDIT_PARAMS = Type.Object({
  stageId: Type.String({ description: 'The stage to audit.' }),
  maxItems: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: 'How many pages to list per finding.' }),
  ),
  accept: Type.Optional(
    Type.Object({
      pages: Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 1,
        description: 'Page orders whose over-threshold reading the learner has accepted for now.',
      }),
      reason: Type.String({
        description:
          'Why those pages stay as they are — the real reason, e.g. the counted blocks are strings to ' +
          'copy verbatim (menu paths, config keys) rather than concepts to learn, or the learner said ' +
          'no more pages may be inserted.',
      }),
    }),
  ),
});

export interface AuditToolDeps {
  loadScenes(stageId: string): Promise<readonly Scene[] | null>;
  /** 读「已接受的读数」凭据；默认读 `OPENMAIC_PLAN_FREEZE_DIR` 下的小文件。 */
  readAccepted?: (stageId: string) => Promise<{ pages: Record<string, unknown> } | null>;
  /** 写凭据（`accept` 那一支）；默认落盘。 */
  writeAccepted?: (readings: {
    stageId: string;
    pages: Record<string, { novel?: number; reason: string }>;
    updatedAt: string;
  }) => Promise<boolean>;
}

export function buildCourseAuditTool(deps: AuditToolDeps): AgentTool<typeof AUDIT_PARAMS, unknown> {
  return {
    name: 'course_audit',
    label: 'Audit a course as a whole',
    description:
      'Read-only audit of a whole course (its only write is `accept`, a small per-course receipt): which teaching pages carry no vocabulary over from earlier ' +
      'pages, and which pages introduce far more new material than a page should (the threshold is ' +
      'measured, not guessed). Run this **before repairing an existing course** — it is how you find ' +
      'out which page to split, connect, or leave alone. It changes nothing; the repairs it implies ' +
      'are only ever "add" or "move" (split an overloaded page, add a line that points back at an ' +
      'earlier page) — never delete a page or a concept.',
    parameters: AUDIT_PARAMS,
    executionMode: 'sequential',
    async execute(_id: string, params: Static<typeof AUDIT_PARAMS>) {
      // ★ 唯一的写：`accept` —— 它写的是 per-stage 的**小凭据**（不是课程数据），
      //   目的是让"这门课这几页的超线我们知道了、暂时不修"能被机器记住。
      //   没有它，无状态审计每次都会再报同样的页，而"拆页"有时不可用（用户已明确不再插页）、
      //   有时不该用（读数是"要照抄的字符串"而不是"要学的知识"）。
      if (params.accept) {
        const read = deps.readAccepted ?? readAcceptedReadings;
        const write = deps.writeAccepted ?? writeAcceptedReadings;
        const previous = (await read(params.stageId))?.pages ?? {};
        const pages: Record<string, { novel?: number; reason: string }> = { ...previous } as never;
        for (const order of params.accept.pages) pages[String(order)] = { reason: params.accept.reason };
        const ok = await write({ stageId: params.stageId, pages, updatedAt: new Date().toISOString() });
        return {
          content: [
            {
              type: 'text' as const,
              text: ok
                ? `course_audit: 已把第 ${params.accept.pages.join('、')} 页记成**已接受**（理由：${params.accept.reason}）。以后审计不再把它们当待修报出来；要重新评估就把凭据删掉。`
                : 'course_audit: 凭据**没写进去**（磁盘或权限问题）。这次接受没有生效 —— 别以为记下了。',
            },
          ],
          details: { accepted: params.accept.pages, wrote: ok },
          ...(ok ? {} : { isError: true }),
        };
      }

      const scenes = await deps.loadScenes(params.stageId);
      if (!scenes || scenes.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `course_audit: 这一门没有页面（stageId=${params.stageId}）。先用 \`list_scenes\` 确认 id。`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const audit = auditCourse(
        scenes.map((scene) => ({
          stageId: params.stageId,
          sceneId: scene.id,
          order: scene.order,
          title: scene.title,
          type: scene.type,
          content: scene.content,
        })),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: formatCourseAudit(audit, {
            maxItems: params.maxItems ?? 8,
            acceptedPages: new Set(
              Object.keys((await (deps.readAccepted ?? readAcceptedReadings)(params.stageId))?.pages ?? {}).map(
                (order) => Number(order),
              ),
            ),
          }),
          },
        ],
        details: {
          pages: audit.pages.length,
          overloaded: audit.overloadedPages.map((page) => ({
            order: page.order,
            title: page.title,
            novel: page.novel,
          })),
          unattached: audit.unattachedPages.map((page) => ({ order: page.order, title: page.title })),
          averageCarryRatio: Number(audit.averageCarryRatio.toFixed(3)),
          medianNovel: audit.medianNovel,
        },
      };
    },
  };
}

/**
 * 系统提示词里的那一句 —— **无参、恒定**（§1.2 前缀缓存）。
 *
 * 它只说"什么时候用它"，不塞任何会变的东西（那门课的读数走工具结果）。
 */
export function courseAuditPromptBlock(): string {
  return [
    '## Repairing a course you already made',
    '',
    'Run `course_audit { stageId }` **before** you touch an existing course. It reports, read-only,',
    'which teaching pages are overloaded (they introduce far more new material than one page should)',
    'and which carry nothing over from earlier pages.',
    '',
    '- It is how you decide **which** page to fix — do not guess from the page titles.',
    '- The only repairs it implies are **add** and **move**: split an overloaded page into 2–3 pages',
    '  (never drop a concept), or add a line that points back at an earlier page. Deleting pages or',
    '  concepts to make a finding go away is not a repair.',
    '- A course made before the plan was kept as an artifact has **no plan** — that is expected.',
    '  For those, this audit is the tool; the plan-based checks cannot see them.',
    '- ★ **An overloaded page cannot be patched silently** (2026-10-07). `patch_stage` refuses it',
    "  until you have shown the learner the numbers (that page's novel vs the p90 line) and asked",
    '  which repair they want — then pass `overloadAcknowledged: true`. **The flag is your receipt',
    '  for having asked**: the tool cannot see your conversation, so it trusts the flag. Do not set',
    '  it without actually asking. The reason it exists: asked to "fix Day 1", an agent went straight',
    '  to editing an overloaded page — no audit, no question, no plan shown.',
  ].join('\n');
}
