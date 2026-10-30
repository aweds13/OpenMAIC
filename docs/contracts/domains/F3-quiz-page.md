# F3 自检页 —— 契约

## 这条契约管什么

管「自检页要几道题、实际给了几道题、少给了怎么算」这条边界的对齐，外加一条：这页的内容能不能被不看界面的人读到。

判定只看三件事：请求的题量有没有原样到达真正生成题目那一步、产出题量对不对得上、页面文字能不能抽成文本。不管题目出得好不好、难度合不合适（那是课程设计的事），也不管这页读起来快不快（F2）。

## 逐条验收

### SR-F3.1 自检页题量必须可控传递，不得被下游写死

- **输入**：`generate_scene` 的 `quizConfig.questionCount`，schema 是 `Type.Integer({ minimum: 1, maximum: 30 })`（`lib/server/agent-runtime/generation-tools.ts:124-126`）；缺省时走 `resolveQuizConfig(input)`（`:237`），兜底 `DEFAULT_QUIZ_QUESTION_COUNT = 5`（`:234`）。
- **期望**：显式给的 `questionCount` 原样进 content prompt —— 提示词里出现 `Question Count: 7`，与 `Difficulty: hard`、`Question Types: multiple` 并列；返回值 `details` 带 `quizRequestedQuestions` 与 `quizProducedQuestions` 两个数。省略 `quizConfig` 时兜底值是 **5**，不是 3。非自检页上给 `quizConfig` 必须整批拒、一个字不写，`details.error === 'quiz-config-requires-quiz'`。
- **失败长什么样**：agent 在对话里说「给你出 5 道自检题」，落盘页面永远是 3 道（实测：工作台生成的自检页全是 3 题，而更早手工补过的是 6/8/10 题）；或 `quizConfig` 落在讲解页上却照写不误。
- **判据落点**：`tests/agent-runtime/generation-tools.test.ts`，`describe('generate_scene — quiz question count')` 下的 `passes questionCount through to the quiz content prompt`（`:1020`）、`uses a non-3 default when a quiz page omits quizConfig`（`:1057`）、`rejects quizConfig on a non-quiz page without writing anything`（`:1126`）。命令：`npx vitest run tests/agent-runtime/generation-tools.test.ts`。
- **两边各自要满足**：
  - 工具侧（`lib/server/agent-runtime/generation-tools.ts:124-126,237-246`）：上游 schema 的 `maximum` 是 **30**，而落盘校验（`lib/server/generation/outline-schema.ts:29` `MAX_QUESTION_COUNT = 100`、`:124-127`）是 **100** —— 这是**已知的双上限**：工具层收 1–30，outline 层收到 31–100 也照过。要么把两个数对齐，要么在契约里明写「31–100 只可能从 outline 直接进来、agent 路径进不来」；不许两个数各说各的还都当权威。兜底 `DEFAULT_QUIZ_QUESTION_COUNT` 只在**完全没给**时生效，不得覆盖显式值。
  - 大纲侧（`lib/server/generation/outline-schema.ts:124-127`）：`questionCount` 必须过 `Number.isInteger` 且落在 `1..MAX_QUESTION_COUNT`；`questionTypes` 里不认的取值（如 `'essay'`）要整条丢掉、`difficulty: undefined` 也要整条丢掉 —— 丢掉之后回到「没给」，由兜底值接管。

### SR-F3.2 题量不足必须显式报错，不得静默产出少题的页面

- **输入**：一次 `generate_scene`，`params.type === 'quiz'`，`quizRequested` 来自 `resolveQuizConfig(params.quizConfig).questionCount`；`quizProduced` 来自 `content.questions.length`。典型触发：要 8 道，模型写到第 3 道时响应被截断，`parseJsonResponse` 的修截断分支把数组砍到最后一个完整对象再闭合、当成功返回。
- **期望**：`quizShortfall = quizRequested !== undefined && quizProduced !== undefined && quizProduced < quizRequested`（`generation-tools.ts:692`）为真时，回话必须带 `QUESTION COUNT SHORTFALL`，并**点名三个数**：要几道、实际出几道、还差几道（`asked for 8` / `returned 3` / 文本里带 `差 5` 的算式）；`isError: true`；`details` 里 `quizRequestedQuestions: 8`、`quizProducedQuestions: 3`、`quizShortfall: true` 三个字段都要在。同一次调用还会打一条 `log.warn({ error: 'quiz-question-shortfall' })`，但**日志不算交付** —— 结论必须进回话。
- **失败长什么样**：少题的页面 `isError: false`、回话只字不提，agent 以为写成了；或只说「题少了」不给数字，agent 无法决定补几道；或只在日志里留一条 warn，对话里看不见。
- **判据落点**：`tests/agent-runtime/generation-tools.test.ts`，`describe('generate_scene — quiz question count')` 下的 `reports a truncated quiz instead of quietly shipping fewer questions`（`:1085`，断言回话匹配 `QUESTION COUNT SHORTFALL` / `asked for 8` / `returned 3`，`isError: true`，`details.quizRequestedQuestions === 8`、`details.quizProducedQuestions === 3`、`details.quizShortfall === true`，且 `scenes[0]` 仍在 —— 页面照落盘，但报错）。命令：`npx vitest run tests/agent-runtime/generation-tools.test.ts`。
- **两边各自要满足**：
  - 生成侧（`lib/server/agent-runtime/generation-tools.ts:688-700,786-795,811-813`）：核对必须发生在**写盘之后、回话之前**，两个数都拿得到才算得出来；`details` 里三个字段是**有值才展开**（`...(quizShortfall ? { quizShortfall: true } : {})`），所以「字段不存在」与「字段为 false」是两种意思 —— 不许把 0 当成没跑过。
  - 修复侧（`packages/@openmaic/generation/src/json-repair.ts` 的 Fix 3，`parseJsonResponse<T>` 在 `:43`）：修截断只能修**语法**，不能把「砍掉了几个对象」这件事咽下去；至少要让上游算得出 `produced < requested`。少题页面**不得**当成功落库（允许落盘，但必须带错），这一条与 conventions 的「不静默降级」同源。

### SR-F3.3 自检页内容必须能被非交互读者读到（文本可抽取）

- **输入**：`learnerVisibleText(page)` / `staticPageText(page)`（`lib/quiz/page-text.ts`），`page.content` 形如 `{ type: 'quiz', questions: [{ question, options: [{ label, value }], analysis }] }`。
- **期望**：三类文字全部收得到 —— 题干（`question`）、选项文字（`options[].label`）、解析（`analysis`），各自过一遍 `stripMarkup` 后拼成一段。**选项字母 `value`（A/B/C）不算内容**，不进文本。对 `interactive` 页：先静态读结构文字，再渲染 HTML 取学生看到的 DOM 文本（`renderPageHtml`，jsdom，默认 1500ms 超时 + load 后 50ms）；渲染拿不到文字或渲染抛错，必须退回 `mode: 'source'` 并在 `note` 里**说出来**，绝不把「没渲染出来」表达成「这一页是空的」。`mode` 三态固定为 `'static' | 'rendered' | 'source'`。
- **失败长什么样**：自检页抽出来是空串（题干在但选项 label 没抽，或解析漏了）；或 interactive 页渲染失败后静默返回空文本，审查于是报「这页是空的」—— 实测由此产生过**五页**假阳性，其中一页渲染后三万多字、未渲染零字。
- **判据落点**：`tests/quiz/page-text.test.ts`，`describe('staticPageText')` 下的 `quiz: 收题干、选项文字与解析，不收选项字母`（`:88`）；`describe('learnerVisibleText')` 下的 `interactive: 渲染后拿到的才是学生看到的东西（JS 建出来的正文）`（`:138`）、`interactive: 脚本在 DOMContentLoaded 里抛错 ⇒ 退回源码并**说出来**，绝不假装是空页`（`:152`）、`interactive: 渲染拿不到任何文字 ⇒ mode=source 且有 note（不许静默成空页）`（`:166`）、`interactive: 渲染抛错（而不是渲染出空）也退回源码`（`:180`）、`interactive: 没有 html 时只读结构里的文字并标注`（`:197`）、`slide 不必渲染（走静态）—— 渲染只对 interactive 花钱`（`:206`）；`describe('CDN 全局桩（实测第 17 页就是靠它跑完 init()）')` 下的 `renderMathInElement 缺失会让 init() 走不到，桩上之后正文就出来了`（`:220`）。命令：`npx vitest run tests/quiz/page-text.test.ts`。
- **两边各自要满足**：
  - 抽取侧（`lib/quiz/page-text.ts:110-125`）：`quizText` 只收 `question` / `analysis` / `options[].label` 三处，**故意不收 `options[].value`** —— 那是字母，不是内容；收进来会让覆盖率统计虚高。`interactiveSourceText` 收 `widgetConfig` 的 `description`/`starterCode`/`solution` 与 `hints[]`、`testCases[].description`/`.expected`；同理，`pbl` 分支**故意不收 `roles[].systemPrompt`**（那是给 agent 的提示词，学生看不到）。
  - 渲染侧（`lib/quiz/page-text.ts` 的 `renderPageHtml`）：只许**动态** import jsdom（静态引会把解析器拖进主 bundle）；必须桩掉 `renderMathInElement`/`katex`/`MathJax`/`hljs`/`mermaid`/`CodeMirror`/`Prism`，让页面在**不依赖外部网络**的条件下跑完自己的初始化。渲染成功但文本为空，与渲染抛错，是两种不同的失败，但都必须落到 `mode: 'source'` + `note`。
