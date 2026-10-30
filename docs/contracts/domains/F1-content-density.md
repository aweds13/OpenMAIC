# F1 内容密度与页面形态 —— 契约

## 这条契约管什么

管「一页上的东西到底有没有真的出现在屏幕上、密度够不够、放不下时往哪走」这条边界的对齐。判据全部落在可算事实上：元素边界、文字估算高度、字号取值、字数统计 —— 不落在「好不好看」。

不管讲什么内容、讲得对不对（那是课程设计的事），也不管读者怎么翻页（F2）、自检页几道题（F3）。

## 逐条验收

### SR-F1.1 每页内容必须在画布可视范围内完整呈现，不得依赖滚动或被裁切

- **输入**：`checkLayout(elements: readonly LayoutElement[])`，`elements` 取自 `scene.content.canvas.elements`；每个元素至少带 `left`/`top`/`width`/`height`，文字元素带 `content` 与可选的 `fontSize`/`lineHeight`。画布固定 `CANVAS_WIDTH = 1000` / `CANVAS_HEIGHT = 562.5`。
- **期望**：返回的 findings 里**不含** `overflows-canvas`，也**不含** `text-does-not-fit`。溢出判据是 `left < -0.5 || top < -0.5 || left + width > 1000.5 || top + height > 562.5`；装不下判据是 `estimateTextHeightPx(...) > height + 1`（1px 容差）。刚好贴边（`left: 0, top: 0, width: 1000, height: 562.5`）**不算**溢出。
- **失败长什么样**：元素伸出 1000×562.5 之外；或文字按 1.5 行高估出来的高度超过盒高，末行被切掉。真实溢出长得极像「贴边」—— 实测第 50 页 el14、第 55 页 el10、第 74 页 el14 三处真溢出只有 **+12px**，而估算误报那批余量只有 **+2px**，光看贴不贴边分不出来。
- **判据落点**：`tests/quiz/layout-check.test.ts`，`describe('★★ 版面检查（agent 看不见画面时的替代）')` 下的 `★ 溢出画布：元素伸出 1000×562.5 之外要被抓到`、`★ 刚好贴边**不算**溢出（别把正常版面报成问题）`、`★ 文字装不下：按字号和宽度估算高度，超过盒高就报`、`★★ 估算用的行高是渲染器的 1.5，不是以前写死的 1.6`；`describe('★★ 页面余量：满了但没溢出')` 全组三条。命令：`npx vitest run tests/quiz/layout-check.test.ts`。
- **两边各自要满足**：
  - 生成侧（`lib/quiz/layout-check.ts`、`lib/server/agent-runtime/dsl-tools.ts`）：`estimateTextHeightPx` 的行高常数必须取渲染器真正用的 `TEXT_LINE_HEIGHT`（1.5，来自 `lib/slide/text-metrics.ts`），**不得写死 1.6** —— 写死 1.6 时 Day02 估算报 23 条装不下，真 Edge 只有 3 条，精确率 3/23。
  - 消费侧（`components/canvas/canvas-area.tsx:200`、`:210`）：画布外层与白底容器都是 `overflow-hidden`，页内**不存在**可滚动的正文区 —— 所以不得把「读者会自己往下滚」当通过条件。页内唯一可滚的是自检页自己的 `overflow-y-auto`，那是 F3 的事。

### SR-F1.2 页面内容必须经由 Writing DSL 落成 canvas 元素，不得以纯文本/Markdown 直接投屏

- **输入**：一次 `patch_stage` 或 `generate_scene` 写入后的 `scene.content`，形状为 `{ type: 'slide', canvas: { elements: [...] } }`；每个元素有 `type` 与 `left`/`top`/`width`/`height`。
- **期望**：写入过 `validateSlideCanvas(canvas, previous)`（`lib/server/agent-runtime/course-edit/element-schema.ts:869`）—— 结构不合法就整批拒、点名到字段路径（`canvas/animations/0: unexpected property "legacyFlag"` 这种形状）；落库后的场景能被 `packages/@openmaic/dsl` 的 JSON Schema 判为合法，`type` 与 `content.type` 必须一致。数学走公式元素、表格走表格元素，不得压成一个 text 元素。
- **失败长什么样**：`canvas.elements` 只有一个巨大 text，里面是 `## 标题` 与 `- 要点` 这样的 Markdown 源文（写入路径不做事后加工：没有标记白名单、没有字号归一化、没有几何裁剪，结构合法就原样落库上屏 ⇒ 学生真的会看见 `##` 和 `-`）；或场景 `type: 'slide'` 却配 `content.type: 'quiz'`。
- **判据落点**：结构合法性有判据 —— `tests/agent-runtime/dsl-tools.test.ts` 的 `fully validates a changed canvas field and names the offending item`（`:1371`）与 `rejects invalid values moved or duplicated within a changed field`（`:1408`）；`tests/agent-runtime/patch-stage-gates.test.ts` 的 `describe('★ 元素类型必须在合同内（含 code / video / audio）')` 一组；`packages/@openmaic/dsl/test/schema.test.ts` 的 `describe('generated JSON Schema — SerializedScene')` 下 `accepts a well-formed slide scene`、`rejects a scene missing required fields`、`rejects a scene whose type disagrees with its content (type<->content bound)`。命令：`npx vitest run tests/agent-runtime/dsl-tools.test.ts tests/agent-runtime/patch-stage-gates.test.ts` 与 `npx vitest run --root packages/@openmaic/dsl`。**「canvas 里不许出现 Markdown 源文」暂无自动化判据** —— `grep -rn "markdown|Markdown" tests/agent-runtime/ tests/quiz/` 命中的全是文档解析那批。人工核对方式：写一页后读该页元素的 `content` 字段，确认没有行首 `#`、`-`、`**`；或直接渲染这一页看有没有露出 `##`。
- **两边各自要满足**：
  - 写入侧（`lib/server/agent-runtime/course-edit/element-schema.ts`）：`validateSlideCanvas` 先用 `projectUnchangedHistoricalGeometry` 把**未改动**的 shape 几何投影成合法值，再只报「字段值变了」的那些 issue —— 不得因为旧数据不合法就拒掉一次无关改动，也不得对没动过的字段喊狼来了。它**不检查 Markdown 语法、不检查字数量**，这两条只能靠诊断与审查兜。
  - 渲染侧（`components/slide-renderer/`）：元素按 `type` 分派渲染器；两种播放渲染器（legacy 与 `@openmaic/renderer`）都必须保留 shape-label padding 与 paragraph spacing，不得只改对其中一条（`tests/slide-renderer/screen-canvas-renderer.test.ts` 有 pin）。

### SR-F1.3 单页正文目标密度 350–400 汉字；低于目标必须补内容，不得留白

- **输入**：一页 slide 的 `staticPageText(page).length`（`bodyChars`，只算正文），或一次 `generate_scene` 的 brief 与课程设计 prompt 里的密度要求。
- **期望**：目标区间是 **350–400 汉字**或 **180–220 英文单词**，唯一真源是 `PAGE_DENSITY_TARGET = '350-400 Chinese characters (180-220 English words)'`（`lib/server/agent-runtime/study-mode.ts:50`）。诊断的机械层在这个区间**一个字都不说**（闭嘴区间 `120–800`：`THIN_PAGE_CHARS = 120`、`OVERFLOW_RISK_CHARS = 800`）；低于 120 字必须出提示，且提示指向「加页 / 补内容」，**不得**指向「把句子写长」。
- **失败长什么样**：一页只有 61 个字（实测默认产出均值）；或提示写成「再写长一点」；或密度目标只进了审查侧、生成侧 brief 里没有，两边各写一套数字。
- **判据落点**：`tests/agent-runtime/scene-diagnostics-density.test.ts`，`describe('★ 字数带（机械层）')` 下的 `★ 太薄 ⇒ 说一句，并指向"加页"而不是"塞长句"`（`:35`）、`★ 中间那段（120–800）机械层闭嘴`（`:51`）、`★ 非 slide 页不算字数（正文不在 canvas 里）`（`:57`）；`tests/agent-runtime/course-design-prompt.test.ts` 的 `states the density target and that volume means more pages`（`:36`，断言 prompt 里含 `PAGE_DENSITY_TARGET`）；`tests/agent-runtime/study-mode-density.test.ts` 的 `★ 生成侧（工作台）与审查侧引用的是同一份顺序`（`:70`）。命令：`npx vitest run tests/agent-runtime/scene-diagnostics-density.test.ts tests/agent-runtime/course-design-prompt.test.ts tests/agent-runtime/study-mode-density.test.ts`。
- **两边各自要满足**：
  - 生成侧（`lib/server/agent-runtime/study-mode.ts:50`）：`PAGE_DENSITY_TARGET` 是唯一真源，brief、课程设计 prompt、审查规矩三处引用同一份，不得各写一套；`PAGE_DENSITY_TARGET.replace('350-400','350–400')` 只在呈现层做排版替换。
  - 诊断侧（`lib/server/agent-runtime/scene-diagnostics.ts:116,118`）：`THIN_PAGE_CHARS` 与 `OVERFLOW_RISK_CHARS` 是**提示线，不是合格线** —— 350–400 是容量，字数在六条优先级里排最后，不得把「不到 400 字」判成错。

### SR-F1.4 内容超出单页容量时必须加页，不得压字号、不得删内容

- **输入**：一次 `str_replace` 改动，`path` 形如 `/content/canvas/elements/3/content`，目标元素 `type: 'text'`，新文字按现有字号估出的高度超过盒高。
- **期望**：`textFitRefusal(scene, path, newText)`（`lib/server/agent-runtime/dsl-tools.ts:811`，调用点在 `:740`）在**写入之前**返回拒绝原因，整批原子回滚 —— 回话必须原样带出 `这次**没有写入**（整批原子，不留半成品）。`；拒绝文本必须给出两条出路：`**缩短**到约 N 字以内` 与 `用 add_element 在旁边加一个框，或**把这一页拆成两页**`，外加一句 `★ **不要压字号**`。`needed <= height + 1` 时放行。被拒之后原样重试，必须还是拒。
- **失败长什么样**：写了半页就落库、落库之后才报错；或拒绝文本只说「装不下」不给路，模型于是去压 `fontSize`（那正是「缩成灰块」那条老路）；或拆页时把一句话拆到两页。
- **判据落点**：**`textFitRefusal` 的拒绝文本暂无自动化判据** —— `这一改会` / `不要压字号` / `拆成两页` 三个串在 `tests/` 下 grep 无命中。可用的间接判据是「整批原子」：`tests/agent-runtime/dsl-tools.test.ts` 的 `rolls back the entire batch when a middle op fails`（`:478`）与 `rolls back the entire batch when a str_replace op fails mid-way`（`:920`）。人工核对方式：找一页 120px 高的小文字框，用 `str_replace` 塞 500 字，确认回话同时含 `这一改会**溢出**`、`没有写入`、`拆成两页`、`不要压字号` 四段，且该页 `content` 与调用前逐字相同。
- **两边各自要满足**：
  - 写入侧（`lib/server/agent-runtime/dsl-tools.ts:740,811`）：拒绝必须发生在写之前，对着每个 op 逐个算 —— 不得先写后校验。**已知偏差**：`textFitRefusal` 里算 `maxChars` 仍写死 `fontPx * 1.6`，而 `estimateTextHeightPx` 用 `TEXT_LINE_HEIGHT = 1.5`，提示的「约 N 字」偏保守；改的时候两边要一起改，否则提示会与实际判定脱节。
  - 诊断侧（`lib/quiz/layout-check.ts`）：`no-headroom` 的文案必须指向「先把这一页拆成两页或重排」，**不得**指向压字号；且只在 `boxes.length >= 2` 时报 —— 单块内容占满是正常的，谈不上「没地方加」。

### SR-F1.5 字号下限必须守住，不得为塞内容把 fontSize 压到可读阈值以下

- **输入**：`checkLayout` 收到的文字元素带 `content`（HTML 串），文内 `font-size: Npx` 由 `maxFontSizePx(html)` 用正则 `/font-size:\s*([\d.]+)px/gi` 取最大值；元素自带 `fontSize` 时以元素为准。
- **期望**：正文文字元素的最大字号 `>= MIN_READABLE_FONT_PX`（14，`lib/quiz/layout-check.ts:42`），否则 findings 出 `font-too-small`，文案点名「字号是 Npx，低于可读下限 14px」。判定按**整块文字的最大字号**取值 —— 标题字号不得替正文过关。
- **失败长什么样**：`<p style="font-size: 11px;">` 这种。实测「缩成灰块」是学习者点过名的失败模式，也是 120–135px 小框里最常见的糊法。
- **判据落点**：`tests/quiz/layout-check.test.ts` 的 `★ 字号过小：低于 14px 要报（"缩成灰块"是学习者点过名的失败模式）`（`:116`，输入 `content: '<p style="font-size: 11px;">短句</p>'`、盒 `400×120`，断言 `font-too-small` 命中）与 `★ 两个小工具：取最大字号 / 估算高度`（`maxFontSizePx` 的取值口径）。命令：`npx vitest run tests/quiz/layout-check.test.ts`。**写入路径没有这道闸** —— `MIN_READABLE_FONT_PX` 只在 `lib/quiz/layout-check.ts` 出现，`dsl-tools` 与 `element-schema` 都不引用它，所以「压到 13px 会被拒写入」**暂无自动化判据**，人工核对方式：用 `patch_stage` 把某页正文改成 `font-size: 11px`，确认写入**成功**但回话里带 `低于可读下限 14px`（即：它是诊断，不是闸）。
- **两边各自要满足**：
  - 诊断侧（`lib/quiz/layout-check.ts:352,357`）：`MIN_READABLE_FONT_PX` 是唯一真源，文案里的数字从它取，不得另写一个字面量 14。
  - 生成侧（`skills/agent-runtime/slide-dsl/SKILL.md`）：技能表里 `fontSize` 的默认值写的是 14，与这条下限同量级 —— 改下限时这张表要一起改，否则技能教的默认值会被自己的诊断判成过小。
