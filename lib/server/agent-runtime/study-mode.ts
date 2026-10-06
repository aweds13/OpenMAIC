/**
 * 「听课 / 自学」这条选择在工作台路径上怎么落地。
 *
 * ── 为什么需要单独说这件事 ────────────────────────────────────────
 *
 * 首页那条链（经典路径）用一个 `selfStudyEnabled` 开关处理它：开了就注入
 * 密度覆盖、并且不生成讲稿。工作台这条路**完全不知道那个开关存在** ——
 * `selfStudy` 在整个 agent-runtime 里搜不到。
 *
 * 但直接把这个开关搬过来是**错的方向**：
 *
 *   · 开关是**全局默认**，而这本质上是**每门课的决定**；
 *   · agent 这条路本来就在逐门课问一堆问题（水平、教学法、材料），
 *     搭在同一个提问里是零成本的。
 *
 * 所以这里把它做成 agent 要确认的一件事，而不是一个环境变量。
 *
 * ── 默认值从哪来（学习者 2026-10-04 明确要求）────────────────────
 *
 * 「理论上我设计一门课的时候，大概率都是默认自学的。因为听课信息输入的话，
 *  我讨厌用听力。」
 *
 * 所以：
 *   1. **默认自学**，这个默认值记在画像的「输入方式」一節里 —— 那是学习者
 *      状态，不是这里的规则；
 *   2. 学习者**当次已经说了**（不管说哪个）就**不要再问**；
 *   3. 只有当次没说、画像也没记，才问一次。
 *
 * ── 两个模式实际差在哪（给 agent 的操作要求）────────────────────
 *
 *   听课：内容主要在**讲稿**里，页面可以稀疏。要跑 `generate_actions`。
 *   自学：内容必须在**屏幕上**，讲稿是冗余信息。**不要跑 `generate_actions`** ——
 *         没有讲稿，播放时就不会出现"静静空等"那一段。
 */

/**
 * 页面正文密度的依据，两处引用同一组数字：
 *   · 真实高校课件实测 352–390 字/页（天津大学《程序设计》week 2 讲义幻灯片）；
 *   · 也接近 1000×562.5 画布在可读字号下的上限 —— 再多就要么溢出、要么字缩成灰块。
 */
export const PAGE_DENSITY_TARGET = '350-400 Chinese characters (180-220 English words)';

export function studyModePromptBlock(): string {
  return [
    '## Listen, or read it yourself',
    '',
    'The learner\'s profile records their input preference — **read the profile first**. For this',
    'learner the standing default is **self-study**: they read the material rather than listen to it.',
    '',
    'Resolve the mode in this order, and stop at the first that applies:',
    '',
    '1. **They said it in this request** (e.g. "给我讲一遍" / "做成能听的" / "我自己看") — use that.',
    '   Do not ask again; re-asking a question they already answered wastes their time.',
    '2. **Otherwise use the profile default** (self-study here).',
    '3. **Only if the profile records nothing** — ask once, together with the other planning',
    '   questions.',
    '',
    '| | Listen | Self-study (this learner\'s default) |',
    '|---|---|---|',
    '| Where the content lives | Mostly in the **narration** | **On the page itself** |',
    '| Page text | Sparse is fine — the spoken line carries the explanation | Target ' +
      PAGE_DENSITY_TARGET +
      ' of real body text per page |',
    '| `generate_scene.selfStudy` | `false` | `true` (or omit it — the deployment default is self-study here) |',
    '| `generate_actions` | Run it — this is where the teaching happens | **Do not run it.** ' +
      'With no narration the player does not sit through a silent wait |',
    '',
    '**Narration is a property of the page, not a separate step.** `generate_scene` decides',
    'whether to write speech while it builds the page, from its own `selfStudy` argument — so',
    'telling it nothing is not neutral, it falls back to the deployment default. Do not generate',
    'a page and then delete its narration with `patch_stage`: that spends two model calls to end',
    'up where one would have. Pass the mode on the call that creates the page.',
    '',
    'For **self-study**, every `generate_scene` brief must say so explicitly, because the page',
    'generator does not see this conversation. State the density target, and say that the page',
    'must be readable with no teacher and no audio: definitions, mechanisms, worked examples and',
    'the reasoning that links them all belong on the page. No "as we discussed", no "let\'s look',
    'at" — that is script voice, and there is no script.',
    '',
    'For a **quiz / self-check page**, `generate_scene.quizConfig.questionCount` is the number the',
    'page will really contain. Say the number you told the learner — leaving it out gives the',
    'generator\'s fallback, not the number in your sentence.',
  ].join('\n');
}
