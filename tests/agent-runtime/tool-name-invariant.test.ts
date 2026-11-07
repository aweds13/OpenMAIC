/**
 * ★ 不变式：**我写进模型视野的文字里，点名的工具必须真的存在。**
 *
 * ── 这条测试的来历（一次真事故，两个实例）──────────────────────
 *
 * 2026-10-07 实测抓到两处同类的 bug，都出在我自己的代码里：
 *
 * 1. `planGate` 的三条拒绝消息写着「用 `freeze_plan` 冻结」「用 `plan_revise` 写明理由」——
 *    **两个工具都不存在**（真实的是 `plan_freeze`，动作 freeze/revise）。
 *    agent 照消息去调，只会拿到「没有这个工具」，然后卡在一个它看不懂的指引上。
 *    更糟的是当时的 `plan-freeze.test.ts` **正钉着那两个错名**。
 * 2. `scratch` 无条件让 agent 去调 `update_materials`，而它是**条件注册**的
 *    （`runner.ts`：`materialsIndex ? MATERIALS_TOOL_NAMES : []`）⇒
 *    没配材料库的部署里就是幽灵。那个工具在 M2 里已经不存在了，但教训留下：
 *    提示词点名的工具，必须和实际注册面对得上。
 *
 * 两次都不是"忘了写" —— 是**写了名字却没跟注册面对账**。所以这里把它变成常驻判据。
 *
 * ── 范围（如实说明，别当成它管了全部）──────────────────────────
 *
 * 它只管**本 fork 自己的模块**产出的文字：六个提示词块（含材料面那一块）
 * + 九个工具的 description/参数表 + 门槛的三条拒绝消息。上游那些块不归这里管
 * （它们的文字不随我们的改动变），而全仓对账需要把 4 份重复的
 * `runToBuildAgent` 抽成共享 harness —— 那是另一件事，别混进来。
 *
 * ── 判据（窄，但正是要抓的形状）────────────────────────────────
 *
 * 反引号里、小写开头、**含下划线**的标识符 ⇒ 必须是已注册的工具名。
 * 要求"含下划线"是为了排掉字段名（`stageId`）、文件名（`check.mjs` 里的 `check`）、
 * 常量（`NOVEL_P90` 大写开头）。
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIT_TOOL_NAMES,
  buildCourseAuditTool,
  courseAuditPromptBlock,
} from '@/lib/server/agent-runtime/audit-tools';
import {
  ASSESSMENT_MODES,
  assessmentModePromptBlock,
} from '@/lib/server/agent-runtime/assessment-mode';
import { emptyPlanFreeze, freezePlan, planGate } from '@/lib/server/agent-runtime/plan-freeze';
import {
  PLAN_FREEZE_TOOL_NAMES,
  buildPlanFreezeTool,
  planFreezePromptBlock,
} from '@/lib/server/agent-runtime/plan-freeze-tools';
import {
  PRACTICE_TOOL_NAMES,
  buildPracticeResultTool,
  buildPracticeScaffoldTool,
  practicePromptBlock,
} from '@/lib/server/agent-runtime/practice-tools';
import {
  SCRATCH_TOOL_NAMES,
  buildScratchTool,
  scratchPromptBlock,
} from '@/lib/server/agent-runtime/scratch-tools';
import {
  MATERIAL_TOOL_NAMES,
  buildMaterialTools,
} from '@/lib/server/agent-runtime/material-tools';
import { materialsPromptBlock } from '@/lib/server/agent-runtime/material-prompt';
import type { SceneOutline } from '@/lib/types/generation';
import { declaredParamNames, phantomToolNames, toolLikeTokens } from './_tool-name-tokens';

/** 我自己的模块声明的工具集。 */
const OWN_TOOLS = new Set<string>([
  ...AUDIT_TOOL_NAMES,
  ...SCRATCH_TOOL_NAMES,
  ...PRACTICE_TOOL_NAMES,
  ...PLAN_FREEZE_TOOL_NAMES,
  // 材料面收敛成五个工具后，它们在 runner 里**无条件**注册，所以也是我自己的。
  ...MATERIAL_TOOL_NAMES,
]);

/**
 * **无条件**注册的上游工具 —— 我可以在文字里点名它们，因为任何部署里都在。
 * 这份清单是"我确实点名了、且确认无条件存在"的集合，不是"全部上游工具"。
 */
const ALWAYS_ON_UPSTREAM = new Set([
  'ask_user',
  'generate_scene',
  'patch_stage',
  'read_stage_outline',
  'edit_deck',
  'list_scenes',
]);

/**
 * **条件**注册的上游工具：只有对应能力配了才在。配上它才允许被点名。
 *
 * ★ 现在是空的：五个材料工具在 M2 之后**无条件**注册（`runner.ts` 的
 *   `buildMaterialTools(...)` 不在任何 if 里），所以它们归 `OWN_TOOLS`；
 *   曾经的 `update_materials`/`read_materials` 已经不存在了。空集合保留下来，
 *   是为了让两份配置的检查仍然分两遍跑 —— 提示词块本身仍随 `materialsEnabled`
 *   分叉（scratch 的 promote 段）。
 */
const CONDITIONAL_UPSTREAM = new Set<string>();

function allowedFor(materialsEnabled: boolean): Set<string> {
  return new Set([
    ...OWN_TOOLS,
    ...ALWAYS_ON_UPSTREAM,
    ...(materialsEnabled ? CONDITIONAL_UPSTREAM : []),
  ]);
}

/** 本 fork 自己的模块产出的、模型能看到的所有文字。 */
function ownTexts(materialsEnabled: boolean): { where: string; text: string }[] {
  const texts: { where: string; text: string }[] = [
    { where: 'block:courseAudit', text: courseAuditPromptBlock() },
    { where: 'block:scratch', text: scratchPromptBlock(materialsEnabled) },
    { where: 'block:practice', text: practicePromptBlock() },
    { where: 'block:planFreeze', text: planFreezePromptBlock() },
    { where: 'block:assessmentMode', text: assessmentModePromptBlock() },
  ];

  const tools = [
    buildCourseAuditTool({ loadScenes: async () => null }),
    buildScratchTool({
      ownerId: 'anon:invariant',
      materialTopics: materialsEnabled ? ['java-basics'] : null,
    }),
    buildPracticeScaffoldTool(),
    buildPracticeResultTool(),
    buildPlanFreezeTool({
      loadOutline: async () => undefined,
      loadPages: async () => null,
      saveOutline: async () => true,
    }),
  ];
  for (const tool of tools) {
    texts.push({
      where: `tool:${tool.name}`,
      text: `${tool.description}\n${JSON.stringify(tool.parameters)}`,
    });
  }

  // 门槛的三条拒绝消息 —— 正是第一处 bug 的所在地。
  const entry = {
    id: 'p1',
    order: 1,
    title: '第 1 页',
    type: 'slide',
    keyPoints: ['小点'],
    description: '【Unit U1 · explanation 1/1】brief',
  } as SceneOutline;
  const gateMessages = [
    planGate({ state: emptyPlanFreeze('stage-x'), entries: [], order: 1 }),
    planGate({ state: emptyPlanFreeze('stage-x'), entries: [entry], order: 1 }),
    planGate({
      state: freezePlan(emptyPlanFreeze('stage-x'), { at: 1, entries: [entry] }).state,
      entries: [entry],
      order: 9,
    }),
  ];
  for (const [index, result] of gateMessages.entries()) {
    texts.push({ where: `gateMessage:${index}`, text: result.ok ? '' : result.message });
  }
  return texts;
}

describe('★ 我点名的工具必须真的存在（幽灵工具名 = 把 agent 卡死）', () => {
  it('names no phantom tool when the materials library is NOT configured', () => {
    const allowed = allowedFor(false);
    const offenders: string[] = [];
    for (const { where, text } of ownTexts(false)) {
      for (const token of phantomToolNames(text, allowed)) offenders.push(`${where} → ${token}`);
    }
    expect(offenders, `幽灵工具名：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('names no phantom tool when the materials library IS configured', () => {
    const allowed = allowedFor(true);
    const offenders: string[] = [];
    for (const { where, text } of ownTexts(true)) {
      for (const token of phantomToolNames(text, allowed)) offenders.push(`${where} → ${token}`);
    }
    expect(offenders, `幽灵工具名：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('★ keeps the phantom names out for good (they were really there)', () => {
    // 这条是"回归的方向"：那两个名字曾经真的写在里面，且测试还钉着它们。
    const everything = [...ownTexts(false), ...ownTexts(true)].map((item) => item.text).join('\n');
    for (const phantom of ['freeze_plan', 'plan_revise']) {
      expect(everything).not.toContain(phantom);
    }
  });

  it('★ the retired material tool names are gone from every block', () => {
    // 五个材料工具是**无条件**注册的，所以对账那两条不再靠"条件集"分叉。
    // 这条钉的是更硬的东西：M2 删掉的那些名字，一个字都不许留在提示词里
    // —— 模型照着去调，只会拿到"没有这个工具"。
    //
    // 材料面那两块单独加进来：`materialsPromptBlock` 点名工具最密，
    // 而五个工具的 description 也是模型直接读的。它们不进 `ownTexts`，
    // 因为描述里合法地引用了 action 名（`create_folder`）和状态名
    // （`extraction_required`）—— 那把尺子会把它们误判成幽灵工具。
    const materialTools = buildMaterialTools({
      sessionId: 'ses_invariant',
      ownerId: 'anon:invariant',
    });
    const everything = [
      ...ownTexts(false),
      ...ownTexts(true),
      { where: 'block:materials', text: materialsPromptBlock([]) },
      ...materialTools.map((tool) => ({
        where: `tool:${tool.name}`,
        text: `${tool.description}\n${JSON.stringify(tool.parameters)}`,
      })),
    ]
      .map((item) => item.text)
      .join('\n');
    for (const retired of [
      'update_materials',
      'read_materials',
      'extract_material',
      'wait_for_materials',
      'search_material',
      'list_material_folders',
      'create_material_folder',
      'rename_material_folder',
      'move_materials',
      'rename_material',
    ]) {
      // ★ 边界必须按词判：`search_material` 是 `search_materials` 的前缀，
      //   用 includes 会把这个正名判成退休名。
      expect(everything, `退休工具名还在：${retired}`).not.toMatch(
        new RegExp(`(?<![a-z0-9_])${retired}(?![a-z0-9_])`),
      );
    }
    // 反面：五个正名确实在里面，否则上面那条只是因为那里什么都没写。
    for (const name of MATERIAL_TOOL_NAMES) {
      expect(
        toolLikeTokens(`${materialsPromptBlock([])}\n${materialTools.map((t) => t.description).join('\n')}`),
      ).toContain(name);
    }
  });

  it('★ the two configurations still differ (else the twin checks above agree vacuously)', () => {
    // scratch 的 promote 段随 materialsEnabled 分叉：只有配了材料库才教 agent
    // 先 `add_materials` 写主题。这条钉住"两边真的不一样"，否则上面两条
    // 幽灵名检查会因为两边都同意而一起失效。
    const without = ownTexts(false)
      .map((item) => item.text)
      .join('\n');
    const withLib = ownTexts(true)
      .map((item) => item.text)
      .join('\n');
    expect(without).not.toContain('add_materials');
    expect(withLib).toContain('add_materials');
  });

  it('★ the extractor actually finds tool-shaped names (else the checks above are vacuous)', () => {
    // 一个空集合会让上面所有断言自动通过 —— 所以先证明尺子量得到东西。
    const tokens = ownTexts(true).flatMap((item) => toolLikeTokens(item.text));
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens).toContain('practice_scaffold'); // 调用形状也要抓得到
    expect(toolLikeTokens('`practice_scaffold { stageId }`')).toContain('practice_scaffold');

    // ★ 阳性对照：这把尺子**当年会抓到那个 bug**。没有这一条，上面两条
    //   "没有幽灵名"可能只是因为尺子什么都量不到。
    expect(toolLikeTokens('确认后用 `freeze_plan` 冻结')).toContain('freeze_plan');
    expect(toolLikeTokens('用 `plan_revise` 说明理由')).toContain('plan_revise');

    // 反面：字段名/文件名/常量不该被当成工具名。
    expect(toolLikeTokens('`stageId` `check.mjs` `payloadVersion` `NOVEL_P90`')).toEqual([]);
  });

  it('★ the three assessment modes are still named (a sanity check on the block)', () => {
    const block = assessmentModePromptBlock();
    for (const mode of ASSESSMENT_MODES) expect(block).toContain(mode);
  });

  it('★ the material tools declare no scope, no deletion and no preparation', () => {
    // M2 验收第 ① 条。写成对 schema 的断言而不是对文件文本的断言：
    // 参数表就是模型拿到的那一份，比 grep 源码更贴近事实。
    const tools = buildMaterialTools({ sessionId: 'ses_invariant', ownerId: 'anon:invariant' });
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MATERIAL_TOOL_NAMES].sort());
    const params = declaredParamNames(tools);
    for (const forbidden of ['scope', 'delete', 'remove', 'prepare']) {
      expect(params.has(forbidden), `材料工具不该有 ${forbidden} 参数`).toBe(false);
    }
    // 反面：真正存在的参数确实在，免得上面那条因为参数表是空的而通过。
    for (const expected of ['materialId', 'folderId', 'limit', 'before', 'topic', 'content']) {
      expect(params.has(expected), `材料工具缺参数 ${expected}`).toBe(true);
    }
  });
});
