/**
 * 课程设计质量 —— 把提示词审计里那几条建议，做成**应用层**的规则。
 *
 * ── 这份文件在解决什么 ────────────────────────────────────────────
 *
 * 2026-10-04 的提示词审计发现，默认产出"单薄"和"概括"的根因在 SDK 层：
 *
 *   · `slide-content/system.md:21`  "Keep every text element under ~20 words"
 *   · `slide-actions/system.md:136` "Speech is where all verbal content belongs"
 *   · `requirements-to-outlines/system.md:303-304`
 *         description 只有 "1-2 sentences"、keyPoints 只有 "3-5 core points"
 *   · `scene-generator.ts:1095`     `allOutlines: [outline]` —— 生成某页时看不到其它页
 *
 * 那些文件在 `packages/@openmaic/` 下，官方规则是"当只读用"。所以这里不改 SDK，
 * 而是把这些**要求**翻译成 agent 能执行的规则 —— agent 读这段，然后把它写进
 * 每次 `generate_scene` 的 brief（brief 是内容生成器唯一能收到的指令）。
 *
 * ── 为什么深度和贯通要放一起说 ────────────────────────────────────
 *
 * 它们看着是两件事，其实是同一件事的两面：
 *   深度 = 一个知识点在一页里展开够不够
 *   贯通 = 页与页之间有没有承接
 * 一个知识点只写一句"是什么"，它既没有深度，也无法和别页产生关系。
 * 所以拆解做对了，贯通是自然结果 —— 但**必须显式要求前者**，模型不会自发做。
 *
 * ── 数字的来源（不是拍的）────────────────────────────────────────
 *
 *   真实高校课件实测 **352–390 字/页**（天津大学《程序设计》week 2 讲义幻灯片；
 *   `slide-content` 默认产出只有 **92 字/页**，差约 4 倍）。
 *   该数字也接近 1000×562.5 画布在可读字号下的上限。
 *   要更多总量就**加页数**，不要往一页里堆。
 */
import { PAGE_DENSITY_TARGET } from './study-mode';

export function courseDesignPromptBlock(): string {
  return [
    '## Designing the course, not just the pages',
    '',
    'The page generator sees **only the brief you write**. These requirements therefore belong in',
    'every brief — they are not things the generator will infer.',
    '',
    '### Decompose each knowledge point — do not just name it',
    '',
    'A page that says "变量名 / 值 / 赋值" has named three things and taught none. Every knowledge',
    'point on a page must carry at least **two layers**:',
    '',
    '- **What it is** — the definition, in one precise sentence.',
    '- **How it behaves, or why it matters** — the mechanism, the rule, the failure mode, a worked',
    '  example, or the contrast with something the learner already knows.',
    '',
    'If a point cannot fill those two layers, it is either too thin to be a page of its own, or it',
    'belongs merged with a neighbour. Say which, rather than padding it.',
    '',
    '### Pages must acknowledge each other',
    '',
    'A deck is not a pile of independent pages. When a page builds on an earlier one, **say so on',
    'the page** ("取上一页的 `age`，现在把它改成字符串") instead of restarting the explanation from',
    'nothing. When a page will be needed later, say what it is setting up. Keep the running example',
    'running: if page 2 introduces a temperature converter, page 7 should still be using it.',
    '',
    '### Density',
    '',
    `A page that is meant to be read (self-study mode) targets ${PAGE_DENSITY_TARGET} of real body`,
    'text. **More total material means more pages, not more words per page** — past that range the',
    'text either overflows the canvas or shrinks into an unreadable block.',
    '',
    '### Terms',
    '',
    'The first time a technical term appears anywhere in the course, give the English original',
    'alongside the Chinese ("变量（variable）"). After that, use the Chinese alone — repeating the',
    'pair on every page is noise, not rigour. Keep this consistent across pages: the page generator',
    'cannot see the other pages, so **you** are the only thing that knows this is the first',
    'occurrence.',
    '',
    '### PBL: model the project on something that already exists',
    '',
    'A PBL page asks the learner to build something. **Do not invent the project from scratch** —',
    'that produces a toy whose shape teaches nothing about how real code is organised.',
    '',
    '1. **Find a mature, real project first** — search for a well-established repository in this',
    '   domain using whatever search or repository tools this session actually has, and never name',
    '   a tool that is not in your tool list. Prefer real adoption (stars, recent commits, a',
    '   readable README) over whatever appears first.',
    '2. **Read its structure before modelling on it** — read the README and the directory layout',
    '   with those same tools. Base the milestones on what that project actually does.',
    '3. **Say what you borrowed and what you added.** In the brief, name the reference project and',
    '   its URL, and state which parts of the plan follow it and which you adapted for a learner.',
    '   A project plan that silently diverges from the source is indistinguishable from an invented one.',
    '4. **Use their own materials for the domain content** — the materials library and',
    '   `course_search`/`read_document` for anything the course already covers. GitHub supplies the',
    '   *shape* of the work; the local material supplies the *subject matter*. Fill the remaining',
    '   gap yourself, and say that that is what you did.',
    '5. **If nothing suitable exists or the search fails, say so** and design a smaller honest',
    '   project. Never claim a reference you did not read.',
    '',    '### Say nothing that only a live teacher could say',
    '',
    'No "让我们一起看看", no "接下来我们学习", no "同学们", no "太棒了". Those belong to a spoken',
    'lecture, and they read as filler on a page. State the content; skip the transition. This applies',
    'to narration too: a spoken line that only announces what is coming next is a line the learner',
    'has to sit through for no information.',
  ].join('\n');
}
