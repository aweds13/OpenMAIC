# 官方 dsh-openmaic 插件做法（实测）

> 勘察对象：`THU-MAIC/dsh-openmaic`，clone 到 `D:/文档/jelly_ware/_tools/dsh-openmaic-upstream`。
> 版本 `0.4.0`，git 只有一笔提交 `09c1693 Initial release: OpenMAIC for DeepSeek Harness (classrooms, slides, interactive widgets, and Socratic teaching)`，无 tag。
> 全部结论来自读源码，未运行任何构建或测试。

---

## 0. 一句话结论

官方插件是**「生成课堂链接 + 在对话里渲染 slide/widget/card」的四个工具 + 四个内置 skill**，1839 行 TS，**完全不碰本地 PostgreSQL**（打的是远程 `open.maic.chat` API）；它与我们那 29 个工具的 `openmaic-course`（把工作台搬进 DSH、直读本地库、能改页）**方向互补、可同时装**。它最值得抄的是三样工程手法：`presentationMeta` 只回一行确认、`ctx.slots.inject` 等槽位声明、沙盒 iframe 的 CSP + 高度回报。

---

## 1. 仓结构与清单

### 1.1 顶层

| 路径 | 大小/行数 | 说明 |
| --- | --- | --- |
| `LICENSE` | 1099 B | MIT |
| `README.md` | 4491 B | 定位、安装、配置、API 流程 |
| `package.json` | 1975 B | 见 §1.2 |
| `dsh.plugin.json` | 530 B | 与 package.json 冗余的插件清单 |
| `cordis.patch.yml` | 144 B | 3 行，见 §1.3 |
| `pnpm-lock.yaml` | 42789 B | |
| `assets/` | 4 个 md + 2 个子目录 | skill 正文，见 §1.4 |
| `src/` | 18 文件 / 1839 行 | 源，见 §1.5 |
| `lib/` | `client.js` / `index.js` / `index.d.ts` | **编译产物随仓提交** |
| `scripts/` | `build.sh` / `test.sh` | 见 §4 |
| `tests/` | 5 个 spec | `client` / `fragment` / `plugin` / `slide` / `widget` |
| `tsdown.config.ts` | 3612 B | 双 entry，见 §4.2 |
| `tsconfig.json` / `tsconfig.client.json` | 386 B / 249 B | 节点半 / 浏览器半分开 |

### 1.2 package.json 关键字段（逐字）

```
"name": "@openmaic/dsh-openmaic"
"version": "0.4.0"
"type": "module"
"main": "lib/index.js"
"types": "lib/index.d.ts"
"engines": { "dsh": ">=0.0.1" }
"files": ["lib", "assets", "cordis.patch.yml"]
```

`exports` 四路：`"."`（types + default）、`"./client"`、`"./cordis.patch.yml"`、`"./package.json"`。

**`dshx.contributes`**（这是我们完全没有的一段声明）：

```json
"dshx": {
  "contributes": {
    "tools": ["openmaic_generate", "openmaic_render", "openmaic_widget", "openmaic_slide"],
    "skills": ["openmaic-render", "openmaic-widget", "openmaic-slide", "openmaic-teach"]
  }
}
```

**`dsh`**：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" }
}
```

`peerDependencies` 8 个：`@deepseek-ai/cordis ^4.0.1-rc.1`、`dsh-llm`、`dsh-session`、`dsh-skill`、`dsh-system-prompt`、`dsh-tools`、`schemastery ^3.18.1-rc.1`、`react ^18.2.0`（除 cordis / schemastery / react 外全是 `*`）。

`dependencies` 5 个：`@openmaic/dsl ^0.8.0`、`@openmaic/generation ^0.3.0`、`@openmaic/renderer ^0.1.0`、`echarts ^6.1.0`、`shiki ^4.4.3`。

`devDependencies`：`tsdown ^0.22.2`、`typescript ^5.9.0`。

`scripts`：`build: bash scripts/build.sh`、`test: bash scripts/test.sh`、`typecheck: tsc -p tsconfig.json && tsc -p tsconfig.client.json`。

### 1.3 cordis.patch.yml 全文

```yaml
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: dsh-openmaic
      name: '@openmaic/dsh-openmaic'
```

### 1.4 assets/（skill 正文）

| 文件 | 字节 | 行数 | 干什么 |
| --- | --- | --- | --- |
| openmaic-render.md | 2330 | 56 | 内联 HTML 片段的作者契约（只用内联 body、不用骨架标签、256 KB 上限、自评分 quiz 在本地判、`card`/`btn`/`viz-*` 基类表） |
| openmaic-slide.md | 1460 | 42 | 一页 Slide JSON 的作者契约（画布固定 1280×720，不许自己写 viewportSize/Ratio） |
| openmaic-widget.md | 1676 | 35 | 三种 widget（simulation / game / code）+ 5 条硬要求（完整 HTML 文档、`widget-config` JSON 块、postMessage 监听器、元素命名 `{var}-slider`、触控目标 ≥44px） |
| openmaic-teach.md | 2089 | 48 | 苏格拉底教学法（人格 + 五步教学循环 + 动态辅助工具选择 + 三条护栏） |
| slide-template/system.md、user.md | — | — | slide 元素种类、几何、边距、文字规则 |
| widget-templates/{code,game,simulation}.md | — | — | 三种 widget 的完整模板 |

★ 关键设计：**skill 正文是 assets 里的独立 md，不做代码内嵌**；`src/skill.ts` 用 `readFile` 在 `get()` 时读。这样模型加载 skill 时才付出 token，且改文案不用重新构建。

### 1.5 src/ 逐文件

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 180 | 插件入口：`name`/`inject`/`Config`/`apply`，注册 4 工具 + 1 skill provider + 4 条 system prompt section |
| `src/client.ts` | 134 | 生成课堂的 HTTP 客户端（submit → poll → 回链接），可注入 `fetch` |
| `src/tool.ts` | 94 | `openmaic_render` 工具定义 |
| `src/fragment.ts` | 73 | 片段校验 + `OpenmaicMeta` 窄化（无 I/O、无 DOM，节点半/浏览器半/vitest 三处共用） |
| `src/slide.ts` | 104 | `openmaic_slide` 工具定义 + `normalizeSlide()` |
| `src/slide-meta.ts` | 34 | Slide 的 meta 契约（纯，共用） |
| `src/widget.ts` | 97 | `openmaic_widget` 工具定义 |
| `src/widget-meta.ts` | 101 | Widget 的 meta 契约 + **流式参数解析器** `extractStreamingWidget()` |
| `src/skill.ts` | 100 | `SkillProvider`：4 个候选，`readFile(locator)` 取正文 |
| `src/client/index.tsx` | 47 | 浏览器半入口：注册 3 处 keyed toolview + 1 处 dock |
| `src/client/OpenmaicCard.tsx` | 130 | `openmaic_render` 的卡片（sandbox iframe + 主题桥 + 高度回报） |
| `src/client/WidgetCard.tsx` | 172 | `openmaic_widget` 的卡片（sandbox iframe + 展开覆盖层） |
| `src/client/SlideCard.tsx` | 145 | `openmaic_slide` 的卡片（`SlideCanvas` + 展开覆盖层） |
| `src/client/StreamingWidgetPreview.tsx` | 70 | 输入框中下方的流式代码预览 dock |
| `src/client/shell.ts` | 153 | **沙盒文档组装 + CSP + 高度回报脚本**（纯，无 DOM） |
| `src/client/frame-css.ts` | 121 | 注入 iframe 的样式表（主题令牌 + 基类词表） |
| `src/client/theme.ts` | 47 | 从 `document.body` 读 DSH 的 `--dsw-alias-*` 令牌，桥成 `--dsh-openmaic-*` |
| `src/client/shiki-stub.ts` | 37 | shiki 的本地 stub（浏览器半不能外置也不能内联，见 §4.3） |

★ 一条贯穿全仓的分层纪律：**凡是节点半和浏览器半都要用的契约，单独放进 `*-meta.ts` / `fragment.ts` 这种「纯模块」**，注释里逐字写了原因（`widget-meta.ts` 头注释）：

> The browser bundle must import the meta narrowing from here, never from `./widget.ts`: that module value-imports `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` and `@openmaic/generation`, which tsdown keeps external, so the client bundle would emit `require()` calls the web shell's frozen module table cannot answer and the plugin would fail to load.

---

## 2. 节点半：注册手法

### 2.1 入口骨架（`src/index.ts`）

```ts
export const name = 'dsh-openmaic'
export const inject = ['tools', 'systemPrompt', 'skills']

type Context = CordisContext & {
  tools: ToolRegistry
  systemPrompt: SystemPrompt
  skills: SkillService
}
```

★★ **每一次注册都包在 `ctx.effect(...)` 里，第二参数是字符串标签**：

```ts
ctx.effect(() => ctx.tools.register(defineTool({ … })), 'dsh-openmaic.generate')
ctx.effect(() => ctx.tools.register(openmaicRenderTool()), 'dsh-openmaic.render')
ctx.effect(() => ctx.tools.register(openmaicWidgetTool()), 'dsh-openmaic.widget')
ctx.effect(() => ctx.tools.register(openmaicSlideTool()), 'dsh-openmaic.slide')
ctx.effect(() => ctx.skills.registerProvider(() => openmaicSkillProvider), 'dsh-openmaic.skill')
ctx.effect(() => ctx.systemPrompt.section({ … }), 'dsh-openmaic.generate-prompt')
```

我们现在的 `openmaic-course` 里，`register()` 辅助函数是**直接** `ctx.tools.register(makeTool(...))`，只有 `webServer.register` 包了 `ctx.effect`。差异后果：插件卸载 / 热重载时工具不会被回收（`ctx.effect` 登记的是 disposable）。这是可抄的第一处。

### 2.2 Config 用 schemastery

```ts
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL)
    .description('OpenMAIC API base URL. Point it at http://localhost:3000 to develop against a local OpenMAIC instance.'),
  accessCode: z.string().role('secret').default('')
    .description('Invite code for open.maic.chat. Access codes are not enforced online yet, so leave it empty; fill it in once they are enabled.'),
  pollIntervalMs: z.number().step(1).min(1_000).default(5_000)
    .description('Polling interval in milliseconds. Classroom generation is slow, so 60000 is friendlier than the default.'),
  maxWaitMs: z.number().step(1).min(1_000).default(600_000)
    .description('How long to poll one job before giving up, in milliseconds (default 10 minutes).'),
})
```

★ `accessCode` 用 `.role('secret')` 标记，Loader 会当密钥处理（不进日志/回显）。我们的插件没有任何 Config。

### 2.3 ★★ presentationMeta：只回一行确认，完整内容进持久化 meta

这是官方最有价值的一处，我们一个都没有。三种工具的写法完全一致，以 `src/tool.ts` 为例：

```ts
output: {
  schema: {
    type: 'object', additionalProperties: false,
    properties: { title: {type:'string',required:true}, sizeBytes: {type:'integer',required:true}, fragment: {type:'string',required:true} },
  },
  render: (_args, value) => [{
    type: 'text',
    text: `Rendered "${value.title}" inline (${value.sizeBytes} bytes). The user sees the interactive card in the conversation.`,
  }],
  presentationMeta: (_args, value) => ({
    kind: 'openmaic-render', fragment: value.fragment, title: value.title,
  }),
},
```

`src/tool.ts` 头注释逐字解释为什么：

> Project the fragment into persisted meta so the card survives replay: the canonical value is not on the wire, only content + meta are.
> Model-facing text stays a one-line confirmation; the fragment is the model's own argument and re-echoing it would double its context cost.

即三条收益：
1. **省上下文** —— 模型自己写的 256 KB HTML 不会被 tool 结果再回灌一遍（双倍成本）。
2. **重放稳定** —— 卡片内容来自日志里的 `tool/result` meta，不是文件、不是重新生成，历史滚动回去逐字节一致。
3. **浏览器半拿得到完整 payload** —— toolview 从 `block.meta` 取，不经内容通道。

配套的两个钩子：

```ts
presentCall: () => ({ card: 'generic', title: 'OpenMAIC', kind: 'other' }),
presentResult(_args, result) {
  if (result.isError) return undefined
  const meta = openmaicMetaFrom(result.meta)
  if (meta === undefined) return undefined
  return { card: 'generic', title: `OpenMAIC · ${meta.title}` }
},
```

★ 注释点明一个细节：「The completed title derives from persisted meta, not args, so replay of a defaulted title still shows the resolved one.」——标题默认值在 `execute` 里解析，`presentResult` 读 meta 才能重放时也显示解析后的标题。

### 2.4 三条工具共同的输出纪律

- `isConcurrencySafe: () => true` —— 纯校验、不碰共享状态。
- `additionalProperties: false` 的 output schema —— 输出形状锁死。
- 出错走 `throw new Error(...)`，由框架转 `isError`，不自己拼错误对象。

### 2.5 systemPrompt section

```ts
ctx.effect(() => ctx.systemPrompt.section({
  name: 'tool:dsh-openmaic',
  order: 117,
  text: GENERATE_PROMPT_TEXT,
}), 'dsh-openmaic.generate-prompt')
```

四条 section 的 `order` 依次 **117 / 118 / 119 / 120**，`name` 形如 `tool:dsh-openmaic`、`tool:dsh-openmaic-render`、`tool:dsh-openmaic-widget`、`tool:dsh-openmaic-slide`。

文案本身很短（每条 100–140 词），说的是「什么时候用这个工具、参数怎么给、成功之后怎么呈现」，不重复工具描述。

---

## 3. 浏览器半：注册与沙盒

### 3.1 ★★ slots.inject 等声明再 register

```ts
export const inject = ['slots']

ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'openmaic_render' }, OpenmaicCard,
))
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'openmaic_widget' }, WidgetCard,
))
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'openmaic_slide' }, SlideCard,
))
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
  { name: 'conversation.input.dock', id: 'openmaic-widget-stream', order: 30 },
  StreamingWidgetPreview,
))
```

注释逐字给出原因：

> Waiting on the holes' declarations mirrors the official registrants: entry application order is loader-driven, and a direct register racing the declaration fails boot.

对照我们：`lib/client.src.js:1140` 与 `:1146` 已经是 `ctx.slots.inject('main', …)` / `ctx.slots.inject('sidebar.panellist', …)` 的写法 —— **这条我们已经做对了**，不是缺口。

### 3.2 ★★ 沙盒 iframe 安全模型（`src/client/shell.ts`）

卡片是 `<iframe sandbox="allow-scripts">`（不透明 origin，拿不到宿主页面），文档自带 CSP meta：

```
default-src 'none'
script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: <7 个 CDN>
style-src 'unsafe-inline' blob: data: <7 个 CDN>
img-src / font-src / media-src 同上
worker-src blob:
connect-src blob: data:
frame-src 'none'
object-src 'none'
base-uri 'none'
form-action 'none'
```

7 个 CDN 白名单（`RESOURCE_ORIGINS`）：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`fonts.bunny.net`、`fonts.googleapis.com`、`fonts.gstatic.com`、`unpkg.com`。

★ 关键取舍：`connect-src` 只给 `blob: data:` —— **模型写的片段不能发网络请求**（skill 里明写「Inline all data. The frame blocks fetch/XHR/WebSocket」）。这是「卡片内容是模型生成的任意 HTML」这个前提下唯一能站住的安全边界。

文档组装（`buildFrameDoc`）还带：
- `<meta name="referrer" content="no-referrer">`
- `<meta http-equiv="Content-Security-Policy" content="…">`
- `:root { --dsh-openmaic-* }` 主题变量注入（值先过 `sanitizeCssValue()`：遇 `/[;{}<>]/` 直接丢空）

### 3.3 ★ 高度回报协议

沙盒 frame 的文档父窗口读不到，所以 frame 自己报高度：

```js
parent.postMessage({ type: 'dsh-openmaic:height', token: <callId>, height: document.documentElement.scrollHeight }, '*')
```

`ResizeObserver` + `load` 各触发一次；父侧 `WidgetCard` / `OpenmaicCard` 用 `addEventListener('message')` 收，**校验 `type` 与 `token`（= callId）双重匹配**后才 `setHeight(Math.max(MIN, Math.min(Math.ceil(h), CAP)))`。

- fragment 卡：`MIN_HEIGHT = 48`、`HEIGHT_CAP = 800`
- widget 卡：`MIN_HEIGHT = 480`、`HEIGHT_CAP = 1600`

★ 用 `token === callId` 而不是只判断 `type`，防的是同页面多个卡片互相串高度。

### 3.4 主题桥（`src/client/theme.ts`）

从 `document.body` 的 computed style 读 6 个 DSH 令牌，桥成 frame 的 `--dsh-openmaic-*`：

| frame 变量 | DSH 令牌 |
| --- | --- |
| `foreground` | `--dsw-alias-label-primary` |
| `card` | `--dsw-alias-bg-layer-1` |
| `muted-foreground` | `--dsw-alias-label-caption` |
| `border` | `--dsw-alias-border-l2` |
| `primary` | `--dsw-alias-brand-primary-new-colorprimary-new-color` |
| `primary-foreground` | `--dsw-alias-label-primary-inverted` |

`colorScheme` 判定四级回退：computed `color-scheme` 含 dark 且不含 light → dark；反之 light；否则看 `body[data-ds-dark-theme]`；否则 `matchMedia('(prefers-color-scheme: dark)')`。

`OpenmaicCard` 里还挂了 `MutationObserver`（观察 `documentElement` 与 `body` 的 attributes）+ `matchMedia` change，任一触发就让 `useMemo` 重算文档 —— 即**用户切换 DSH 主题时卡片跟着变**。

### 3.5 SlideCard 与我们的差异

```tsx
import { SlideCanvas } from '@openmaic/renderer'
import type { Slide } from '@openmaic/dsl'
const SLIDE_HEIGHT = 480
…
<div style={{ width:'100%', height: SLIDE_HEIGHT, overflow:'hidden', … }}>
  <SlideCanvas slide={slide} />
</div>
```

★ 官方调 `SlideCanvas({slide})` **没有 `canvasPercentage`**，靠固定 480px 容器自动适配；我们 F10 契约里写的是 `SlideCanvas({slide, canvasPercentage: 6})`。两者不是对错，是容器策略不同（我们有滚动阅读的面板，它有固定高度的卡）。官方多了「⛶ 展开」覆盖层（`position: fixed; inset: 0; zIndex: 1000`）—— 这个我们面板里没有。

### 3.6 流式预览（独有）

`StreamingWidgetPreview.tsx` 挂在 `conversation.input.dock`（输入框上方），只在「当前 partial 里有 `openmaic_widget` 的 tool-call 块」时出现，用 `extractStreamingWidget(argsRaw)` 从**未完成的 JSON 参数前缀**里解出已流的 html，显示成等宽代码（`maxHeight: 200`，自动滚到底）。

解析器（`widget-meta.ts`）的要点：找 `"html"\s*:\s*"` 开头，逐字符解 JSON 转义，**遇到不完整的 `\uXXXX` 或结尾单反斜杠就停下返回已有部分**，不猜、不报错。

---

## 4. 构建纪律（三道防漂移守卫）

### 4.1 `scripts/build.sh` 核心

1. 定位 harness checkout：`dsh` 可执行文件 → `<checkout>/bin/dsh` → 上一层，且必须同时有 `packages/` 和 `vendor/`；否则 `build: cannot locate the harness checkout (set DSH_CHECKOUT or put dsh on PATH)`。
2. `link_pkg` 把依赖软链进 `node_modules/@deepseek-ai/`：节点半 10 个（cordis / cosmokit / schemastery / dsh-brand / dsh-llm / dsh-scope / dsh-session / dsh-skill / dsh-system-prompt / dsh-tools），浏览器半 8 个（dsh-client-runtime / ui-tool / ui-slots / ui-conversation / ui-primitives / web-react / ui-attachment / schema-form）。
3. `react` / `@types/react` / `@standard-schema/spec` 从 `node_modules/.pnpm` 里 `find` 出真实目录再软链（不在 hoist 位置）。
4. `"$TSDOWN"` 构建。
5. ★★ **三道守卫**（这是我们完全没有的）：

| 守卫 | 判据 | 报错原文 |
| --- | --- | --- |
| ① 客户端外部依赖白名单 | `lib/client.js` 里每个 `require("…")` 必须在 `ALLOWED_CLIENT_REQUIRES`（react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis / dsh-client-runtime/client / dsh-client-ui-slots / dsh-client-web-react / dsh-client-ui-primitives / dsh-client-ui-attachment / dsh-client-schema-form） | `the browser half must not import a node-half module for a value` |
| ② 不许有动态 import | `grep -o 'import("[^"]*")' lib/client.js` 必须为空 | `the browser bundle kept dynamic imports the browser cannot resolve` |
| ③ 不许有 chunk | `find lib -name '*.cjs'` 必须为空 | `the browser bundle split into chunks the loader cannot fetch` |

三条守卫的共同前提（脚本注释逐字）：「The web shell hands the plugin factory a `require` backed by a frozen module table; a require for anything outside that table fails the whole loader entry at boot ("missed the module table").」

### 4.2 tsdown 双 entry

节点半：
```ts
{ entry:{index:'src/index.ts'}, outDir:'lib', format:['esm'], platform:'node', target:'es2024',
  fixedExtension:false, dts:true, clean:true,
  deps:{ neverBundle:['@deepseek-ai/schemastery','@deepseek-ai/cordis'] } }
```
★ `schemastery` 必须 `neverBundle` —— Loader 要用**自己的实例**校验插件的 `Config` schema（bundled 一份会是另一个实例，校验不过）。

浏览器半：
```ts
{ entry:{client:'src/client/index.tsx'}, outDir:'lib', format:'cjs', platform:'browser', dts:false, clean:false, deps:{ … } }
```
`format: 'cjs'` + 单个 `lib/client.js`（loader 只取一个 classic script）。

### 4.3 shiki 三难（注释逐字）

> shiki is a lazy optional peer of the renderer (code highlighting). It cannot ship either way — external leaves a bare `import("shiki")` the browser cannot resolve in a classic script, bundled it drags every TextMate grammar in as a separate chunk the loader cannot fetch — so the browser build resolves it to a local stub and the renderer falls back to plain text.

即：外置不行、内联不行，只能 stub。这是「浏览器半只有一个 classic script」这个约束下的通用解法。

---

## 5. 测试做法（`tests/plugin.spec.ts`）

不是 mock 插件上下文，而是**真装 Cordis 组合**：

```ts
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(SkillService)
await ctx.plugin(ToolRegistry)
await ctx.plugin(DshOpenmaic, config)
```

然后通过 `ctx.tools.execute({ name, arguments, callId, signal, agent })` 断言**模型可见的契约**，跟 dsh 实际调用完全同一条路。`afterEach` 里 `await ctx.fiber.dispose()` 逐个收。

`fetch` 用 `vi.stubGlobal` 打桩，并捕获 `captured.bodies` / `captured.urls` 断言请求体。

★ 这种做法我们做不到同样的程度（我们的插件是 JS + 自建 `_probe/` + `smoke-*.mjs` 脚本，不是 vitest 真组合），但至少可以抄「断言模型可见契约而不是断言内部函数」这个取向。

---

## 6. 与我们的对照（差距清单）

| 项 | 官方 | 我们（`openmaic-course`） | 差距后果 |
| --- | --- | --- | --- |
| 注册在 `ctx.effect` 里 | 全部 | 只有 `webServer.register` | 卸载/热重载时工具与 prompt 不回收 |
| `presentationMeta` | 三工具都用 | **零** | 工具结果把完整 payload 回灌模型，双倍上下文；重放靠重算 |
| `systemPrompt.section` | 4 条（order 117–120） | **零** | 模型不知道「什么时候该用 `openmaic_active`」这类调用时机，只能靠工具 description 猜 |
| `skills.registerProvider` | 4 个内置 skill | **零** | 没有「作者契约」层；我们的用法知识散在 AGENTS.md 与工具描述里 |
| `Config`（schemastery） | 4 键 + `.role('secret')` | **零** | 落点/端口全写死在代码里，改一次要改代码 |
| `dshx.contributes` / `dsh.plugin.json` | 都有 | **都没有** | 不在插件市场的可发现清单里，「共建生态」这一层缺门面 |
| `engines.dsh` | `>=0.0.1` | 无 | 没有版本契约 |
| 构建三道防漂移守卫 | 有 | 无（自建 `build.mjs` 只做 esbuild 打包） | 客户端半一旦误引节点半模块，要到运行时 boot 失败才发现 |
| 沙盒 iframe CSP | 完整 | 无 iframe（面板是 React 原生渲染） | 我们不需要 —— 我们不执行模型生成的任意 HTML |
| 高度回报协议 | 有 | 无（面板是固定布局） | 同上，不需要 |
| 流式预览 dock | 有 | 无 | 我们的产物不是模型现写的长 HTML，收益低 |
| 展开覆盖层 | slide/widget 都有 | 无 | 面板里读长页面时缺一个全屏阅读入口 |
| 测试 | vitest 真 Cordis 组合 | npm 脚本冒烟 | 断言层面不同（契约 vs 现象） |

---

## 7. 可执行的三件事（按收益排序）

### 7.1 给单页渲染加 `presentationMeta`（收益最高）

现在 `openmaic_page` 是 `output: { schema: {type:'json'}, render: (_a,v) => textOut(v) }` —— 整页 JSON（含 canvas）全量回灌模型。而面板渲染走的是另一条路（`/dsh-openmaic/page` 缝），tool 结果与面板显示其实是两份内容。

改法（只动 `lib/index.js` 的该工具定义）：
1. `output.schema` 改成 `{type:'object', additionalProperties:false, properties:{stageId, sceneId, type, title, bytes, canvasOk}}` 这类**摘要形状**。
2. `render` 回一行：`已读到「<title>」（<type>，<N> 字符）：面板里已渲染。要全文用 openmaic_page_text。`
3. `presentationMeta` 回 `{kind:'openmaic-page', stageId, sceneId, title}`（面板已经从缝里取数据，这里只需重放时的标题）。
4. `presentCall` / `presentResult` **不用加** —— Web Client 不消费这两个值（源码证据见 §8 第 5 条）。

★ 注意：这一改会改变模型看到的东西（从「整页 JSON」变成「摘要 + 指针」），属于行为变更，要先确认模型侧没有依赖整页 JSON 的用法。已经有一个现成的分工：`openmaic_page` 给面板渲染用的原文、`openmaic_page_text` 给模型读的纯文本 —— 更干净的做法是**把 tool 结果的语义明确成「面板已渲染 + 摘要」**，模型要读内容就调 `openmaic_page_text`。

★ **补记（2026-11-05，判定后仍建议不动）**：`presentationMeta` 在我们这里目前**没有消费方**，抄过来的收益是 0，不是「先抄了以后有用」。
- 我方面板走 `main` 座 + `/dsh-openmaic/page` 缝自己渲染，**不是 `tool.call.toolview`**（`lib/client.src.js:1140` 只注入了 `main` 与 `sidebar.panellist` 两处）⇒ 官方那条「toolview 从 `block.meta` 取 payload」的链路在我们这里根本不存在。
- `grep -n "meta" lib/client.src.js` **零命中** ⇒ 浏览器半没有任何读 meta 的代码。
- 因此 `presentationMeta` 唯一的收益是「让模型少看一份 JSON」。但 `openmaic_page` 的 JSON 正是**改页的输入**（`openmaic_patch_stage` 要 canvas），把它换成摘要 + 指针会让「顺手改」多一次往返；只读文本已经由 `openmaic_page_text` 承担。
⇒ 结论：**先不做**。等哪天要把它做成对话里的 `tool.call.toolview` 卡片（而不是 `main` 座面板），再两半一起动。

### 7.2 补插件门面（`dshx.contributes` + `dsh.plugin.json` + `engines`）

现在 `package.json` 只有：
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform":"web", "inject":[...] } }
```
缺官方那套 `dshx.contributes`（tools 29 + skills 0）与独立的 `dsh.plugin.json`。若目标是「共建生态」，这一层是别人能不能发现/安装我们的前提。

配套要定的事：29 个工具名要不要改前缀（官方用 `openmaic_*`，我们用 `openmaic_*` —— 有重名风险，`openmaic_generate`/`openmaic_render`/`openmaic_widget`/`openmaic_slide` 四个已经被官方占了）。

★★ **这是一个必须先决的冲突**：如果两个插件同时装（官方 + 我们），`name` 冲突会怎样？需要实测（官方四个名字 vs 我们 29 个名字，目前交集为空 —— 我们的叫 `openmaic_courses`/`openmaic_page`/`openmaic_patch_stage` 等，官方是单数四个）。我核过：**交集为空**，可共存。但若将来我们加一个 `openmaic_slide`，就会撞。

### 7.3 工具注册包 `ctx.effect` + 加 systemPrompt section

- ~~把 `register()` 里的 `ctx.tools.register(makeTool(...))` 包进 `ctx.effect(…)`，收益是「卸载时回收」~~ —— **这条已经被推翻**，见 §8 第 6 条的源码推导：`ctx.tools.register()` 返回的 disposer 本来就挂插件 fiber，插件卸载会回收。包一层只得到 effect 树里的可读标签，**不是必须项**。
- 给最容易被误用的 3–5 个工具各写一条 systemPrompt section（`openmaic_active` 的时机、`openmaic_page` vs `openmaic_page_text` 的分工、`openmaic_patch_stage` 必须先 dryRun）。order 选一个不会跟官方 117–120 撞的段（比如 130 起）。

---

## 8. 诚实清单

1. **没跑过官方插件的构建**。`scripts/build.sh` 要求 harness checkout 有 `packages/` 与 `vendor/` 两个目录，本机装的是打包后的 `app.asar`（`D:/DeepSeek Harness/resources/app.asar`），`dsh` 也不在 PATH 上 ⇒ 无法满足前置条件。§4 的守卫逻辑是读脚本得到的，不是跑出来的。
2. **没跑过官方测试**。同理（`$CHECKOUT/node_modules/.bin/vitest` 取不到）。
3. **没装官方插件到本机 profile 实测共存**。`openmaic_*` 名字交集为空是**静态比对**（官方 4 个 vs 我们 29 个），不是运行时验证。两插件同时装会不会有别的冲突（slot key、client bundle 加载顺序）**未知**。
4. **`@openmaic/dsl` / `generation` / `renderer` 版本不匹配风险未验证**。官方依赖 `dsl ^0.8.0` / `generation ^0.3.0` / `renderer ^0.1.0`；我们仓里的本地包版本没核。若两插件同时装且各自带一份 `@openmaic/*`，会不会出现双实例（尤其 `SlideCanvas` 的 React 上下文）**不知道**。
5. ~~**`presentationMeta` 在我们这个 DSH 版本的可用性未验证**~~ —— **已由源码取证 + 运行时读数推翻下方原猜测**。从 `D:/DeepSeek Harness/resources/app.asar`（182766714 B）里逐字读到 `ToolRegistry.register(definition)`：

```js
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function"
      || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function")
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  ...
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

★ 结论三条：① **裸 spec 完全合法** —— 注册表只要求 `{name, output:{schema, render, presentationMeta?}}`，不要求任何 marker（`isHarnessToolDefinition` / `REGISTER_TOOL_MARKER` 在 asar 里 0 命中）⇒ 我们的 `toJsonSchema` 翻译层就是 `defineTool` 里 `normalizeParameterSchemaSpec` 的等价物，`defineTool` 拿不到**不影响**挂 `presentationMeta`；② `presentationMeta` 的返回值经 `snapshotProjection(toolName,'presentationMeta',projected)` 快照后直接进 `result.meta`（`createSuccessResult` 逐字），必须无损 JSON；③ `presentCall`/`presentResult` 是给 CLI 等 Host 本地消费方的，asar 内置中文文档逐字「**内置 Web Client 不消费这些值**，而是通过 `tool.call.toolview` 选择 renderer，并从原始调用参数、结果内容、失败状态与持久 metadata 派生 card props」⇒ 我们只做 Web，**只抄 `presentationMeta` 就够**。

原猜测（保留作记录）：曾以为 `presentationMeta` 只有走官方 `defineTool` 才有，而我们 `lib/index.js` 因 profile 里没有 `@deepseek-ai/*` 作用域走的是裸 spec fallback ⇒ 不可用。现已证伪。

6. ~~**`ctx.effect` 第二参数（字符串标签）的语义**没查源码~~ —— **已查**。asar 里 Cordis `Fiber.effect(execute, label = "anonymous")` 逐字：`const meta = { label, children: [] };` ⇒ **纯诊断标签**，不参与 key 生成、不影响去重；它挂在返回的 disposer 上（`dispose[symbols.effect] = meta`），只在调试/树状转储时可见。

   ★★ 同处更正了 §7.3 的一条说法。`ToolRegistry.register()` 自己是 `return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" })`，而 `ScopedLayers.effect(ctx, action, options)` 的第一行就是 `const scope = scopeOf(ctx)`、紧接着 `return ctx.effect(function* () { … })`。**关键在于 `this.ctx` 在这里是谁**：`ToolRuntime` 是 `class extends Service`（`super(ctx, "tools")`），Service 的 tracker 是 `{associate: name, property: "ctx"}`；`createTraceable` 的 get 陷阱里 `if (prop === tracker.property) return ctx;` 返回的是**访问方**的 ctx，且方法调用经 `createShadowMethod` 把 `thisArg` 换成带 `ctx = 调用方 ctx.extend(...)` 的 shadow。

   ⇒ **插件里 `ctx.tools.register(...)` 得到的 disposer 本来就挂在插件自己的 fiber 上**，插件卸载时工具会跟着回收。官方外面再包一层 `ctx.effect(...)` 的作用是**给这层一个可读标签、进 effect 树**（`tools.register()` 那个 label 是写死的），**不是**回收的前提。

   结论：我方 `register()` 没包 `ctx.effect` **不是泄漏**（此前判断作废）。要包也只是为了调试树的标签，收益小。**这一条是读源码推的，没有运行时验证**（本机无 cordis 可 import，见 §8 第 5 条）。
7. 官方的 `openmaic_generate` 打远程 API，**没有实测过一次真实生成**（需要 accessCode / 网络）。
8. `frame-css.ts` 里 `--dsw-alias-brand-primary-new-colorprimary-new-color` 这个令牌名看起来像是拼接错误（`new-color` 重复），但我没有 DSH 的令牌真源可对照（`docs/config-catalog` 不在安装产物里），**不知道**它是否真的是这个名字。

### 补记（运行时验证，2026-11-05）

`presentationMeta` 不只在源码里存在，本机会话日志能直接读到它落地。`D:/DeepSeek Harness/resources/app.asar` 里 bash 工具的定义带 `presentationMeta: (_args, value) => ({ cwd: value.cwd })`；会话 `C:/Users/asus/.dsh/sessions/--D-~6587~6863-jelly_ware-program-engineering--/e88ceca6-cad3-41f1-ba00-e7d0b3faddfe/session.v4.jsonl.zstd`（577 行，`tool/result` 107 条）里 **106 条 tool/result 带 `data.meta`**，值形如 `{"cwd": "D:\文档\jelly_ware\program\engineering\.wt\E89"}`。

⇒ 三点结论：
- **`presentationMeta` 在本机 DSH 版本里真的被调用，返回值真的进 `tool/result` 的 `meta`**。
- 位置是 **`data.meta`**，不是 `message.meta`（后者 0 条）—— 读的地方要读 `data.meta`。
- 我方插件仍未挂它（`lib/client.src.js` 里 `grep meta` 零命中，浏览器半没有消费方）—— 要抄得**两半一起动**：宿主半产出 meta、浏览器半从 meta 取 payload 渲染。

---

## 9. 指针

- 官方仓本地副本：`D:/文档/jelly_ware/_tools/dsh-openmaic-upstream`（`--depth 1`，单提交）
- 我方插件源：`D:/文档/jelly_ware/_tools/dsh-plugins/openmaic-course`（宿主半 `lib/index.js` 2492 行、浏览器半 `lib/client.src.js` 777 行）
- 我方 DSH 插件开发参考：DSH-技能与插件开发参考.md（408 行，本仓根）
- 我们的 F10 宿主契约：OpenMAIC 仓 D:/文档/jelly_ware/program/OpenMAIC/docs/contracts/domains/F10-dsh-host.md（115 行，**我方自建，不在上游**）
