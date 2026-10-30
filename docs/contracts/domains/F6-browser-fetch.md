# F6 真浏览器抓取 —— 契约

## 这条契约管什么

管「在对话里给一个网址，模型真的把那一页打开看过」这条路的验收：拿得到 JS 执行后的内容、说得出东西是哪来的、不因为页面上出现某个词就判死、看和存是两件事、预览有上限而正文没有。

不管浏览器进程怎么起（8730 的 Playwright + Edge 在另一个服务里），也不管正文抽取的算法 —— 只关心**工具这一层的输入、输出与失败形态**。

## 逐条验收

### SR-F6.1 抓取必须走真浏览器渲染，能拿到 JS 执行后的 DOM

- **输入**：`browse_url`，`url` 必填（http/https），`waitMs` 可选 0–8000（缺省 1500）—— 加载完成后额外等待客户端渲染的毫秒数。
- **期望**：请求打到 `{baseUrl}/browse`（POST JSON，body 含 `url` 与可选的 `maxChars` / `waitMs`），由真浏览器渲染后取 DOM，返回的 `text` 是**渲染之后**的可读正文。`waitMs` 必须原样进 body —— 它是「等 JS 跑完」的唯一旋钮，重 SPA 靠它才拿得到内容。工具 `executionMode` 恒为 `'sequential'`（不并发抢浏览器）。
- **失败长什么样**：走一次裸 HTTP 抓回来一个空壳或 `<div id="root"></div>`，却当成正文返回；`waitMs` 被吞掉，SPA 永远只拿到骨架；或者工具并发执行、互相抢浏览器实例。
- **判据落点**：`tests/chat/pi/browse-url.test.ts` —— `posts the url and renders text + links`（断言打到 `/browse`、body 里 `url` 正确、返回的 `text` 进了 `content`）。命令：`npx vitest run tests/chat/pi/browse-url.test.ts`。`waitMs` 的**透传没有断言**（`grep -rn "waitMs" tests/` 零命中），人工核对方式：对一个明确需要 JS 的页面分别用 `waitMs: 0` 与 `waitMs: 8000` 各抓一次，确认后者拿到的 `textChars` 明显更大。
- **两边各自要满足**：
  - 工具层（`lib/chat/pi/tools/browse-url.ts`）：不得自带 HTTP 抓取兜底 —— 服务没起就是没起，不许偷偷退化成裸 fetch 再谎称「渲染过」。
  - 服务层（8730）：`waitMs` 必须是「load 之后再等」而不是「总共等」；渲染完成前不得回 `ok: true`。

### SR-F6.2 抓取结果必须带可核查的来源标识（最终 URL、状态、耗时）

- **输入**：一次成功的 `browse_url`（服务回 `ok: true`）。
- **期望**：三样来源标识必须同时出现，缺一不可：
  - `details.finalUrl` 且正文第一段的 header 行里也印出来（跳转之后的真实地址，不是请求时的 URL）；
  - `details.httpStatus`（`HTTP <n>`，服务没给就写 `?`，不许编一个 200）；
  - `details.elapsedSec`（`<n>s`）。
  
  header 行形如 `<finalUrl> · HTTP <status> · <textChars> chars[(truncated)] · <elapsedSec>s`。另有 `details.title`、`details.textChars`、`details.links`（最多 40 条）。
- **失败长什么样**：只回正文、不说这是哪个 URL；跳转后仍报原始 URL（引用就引错了）；耗时缺失；`links` 不截断，塞满上下文。
- **判据落点**：`tests/chat/pi/browse-url.test.ts` —— `posts the url and renders text + links`（fixture 备齐 `finalUrl / status / textChars / truncated / links / elapsedSec`，断言 `details.status === 'ok'`、`details.title`、正文含标题与链接），`tests/agent-runtime/browse-url-capability.test.ts` 的 `describe('buildAgentBrowseUrlTool')` 三例（`keeps the tool name and sequential execution` / `describes the browser as the answer to JS pages and 403s, not as a replacement` / `never names a tool this deployment may not have registered`）。命令：`npx vitest run tests/chat/pi/browse-url.test.ts tests/agent-runtime/browse-url-capability.test.ts`。**三样来源标识本身（`details.finalUrl` / `httpStatus` / `elapsedSec` 与那行 header）暂无直接断言** —— 现有用例只钉住了标题与链接。人工核对方式：抓一个会 302 跳转的短链，比对请求 URL 与返回 header 里的 `finalUrl` 不同、`HTTP` 后是跳转后的真实状态码、`elapsedSec` 为数字且明显大于 `waitMs`。
- **两边各自要满足**：
  - 工具层：这三个字段只能从服务响应里映射，不得本地推算；`links` 必须在工具层 `slice(0, 40)`，不指望服务端截。
  - 服务层：`finalUrl` 必须是跟随完重定向后的地址；`elapsedSec` 要包含 `waitMs` 那一段。

### SR-F6.3 反爬/风控判定只允许作用于正文抽取，不得因裸词误伤整页

- **输入**：一个正文可读、但页面里出现 `captcha` / `验证码` 之类裸词的页面（例如前端 bundle 或 `<script>` 里带这个词）。
- **期望**：判定对象只能是**抽取后的正文 markdown**（`${title}\n${content}`），不得对整页 HTML 做子串匹配。真正的拦截页（可见文字里就是「环境异常/完成验证」）仍要判 `blocked`；正常文章只是因为脚本里出现这个词，必须正常返回正文。命中拦截时抛 `FetchUrlError('blocked', 'Page was blocked by anti-bot verification (<marker>)')`。
- **失败长什么样**：正常技术文章因为 JS bundle 里有 `captcha` 被拦（历史事故：一次课 75 次抓取里 2 次被 `(captcha)` 误伤）；或反过来，真拦截页被当成正常内容返回、模型把「请完成验证」当正文总结。
- **判据落点**：`tests/agent-runtime/fetch-url.test.ts` —— `fails loudly when an anti-bot marker is returned with HTTP 200`（断言 `reason: 'blocked'`）与 `does not block a readable page just because its scripts mention captcha`（断言正文取到了、且 `__recaptcha__` 没进 markdown，因为脚本体在抽取时就被丢掉）。命令：`npx vitest run tests/agent-runtime/fetch-url.test.ts`。
- **两边各自要满足**：
  - 抽取层（`lib/web-fetch/builtin-extraction.ts`）：`antiBotMarkers()` 的匹配只接收 markdown，函数签名里就不该出现 HTML；`FETCH_URL_BLOCKED_MARKERS` 只能**追加**词表，不能改动判定时机。
  - `browse_url` 侧：服务回 `error: 'blocked'` 时映射成 `details.status === 'blocked'` 且文案点明「私有/内网地址不可达」（SSRF 拒）或原始 `reason`，**不得**混进 `error`（那会让「被拦」和「坏了」分不清）。

### SR-F6.4 「看」与「存」必须是两个动作，预览不得自动持久化

- **输入**：一次纯 `browse_url` 调用。
- **期望**：`browse_url` **只读** —— 不写库、不落盘、不生成 material、不返回任何 material id。要留存必须另调 `fetch_url`（一次 HTTP 请求 + 抽成 Markdown + **存成 session 的 web material**，返回 material id），再用 `read_material` 分页精读（8000 字符/页）。提示词块必须把这两步写成顺序而不是二选一，并说明「只 browse 不 fetch，压缩上下文之后就引用不到了」。
- **失败长什么样**：`browse_url` 自己顺手存了一份 material（「看」变成有副作用的写）；或提示词只说「优先用真浏览器」，模型读完就走、内容没落成 material，后面生成课件时引用不到。
- **判据落点**：`tests/agent-runtime/browse-url-capability.test.ts` —— `describe('browsePromptBlock')` 的 `lays out look-then-keep so the model does not browse and forget to store`（断言块里同时出现 `browse_url` / `fetch_url` / `read_material`），以及 `describe('browsePromptBlock 的能力条件')` 的两例（`web_search` 没注册时必须删掉那一步并重新编号）。命令：`npx vitest run tests/agent-runtime/browse-url-capability.test.ts`。**「跑完磁盘无新增」这条暂无自动化判据**，人工核对方式：调一次 `browse_url` 后查材料表与工作区文件数，确认都没变；而调一次 `fetch_url` 后确认多出一条 `kind: 'web'` 的 material。
- **两边各自要满足**：
  - 工具层：`browse_url` 的实现里不得 import 任何持久化模块；`fetch_url` 才会 `saveWebMaterial`。
  - 提示词层：`browsePromptBlock` 必须写明「look with browser, keep with fetch_url」，且只点名本部署真的注册了的工具（`web_search` 是另一个能力，不能顺手写进去）。

### SR-F6.5 预览必须有字数上限，正文抽取不受该上限约束

- **输入**：`browse_url` 的 `maxChars`（整数 1000–120000，缺省 40000）与 `waitMs`（0–8000，缺省 1500）；`fetch_url` 的预览（无参数，恒 2000 字符）。
- **期望**：两个上限是**两个数**，不得共用一个常量：
  - `browse_url` 的 `maxChars` 是**本次要多少正文**，上限 120000、下限 1000，超范围在 schema 阶段就被拒；
  - `fetch_url` 的预览硬切 2000 字符（`FETCH_PREVIEW_CHARS`），但**存下来的 material 是全文**，用 `read_material` 分页读（8000 字符/页），预览不构成对正文的约束。
  
  被截断时必须在返回里**明说**：`browse_url` 的 header 带 `(truncated)`；`fetch_url` 在 `hasMore` 时给 `nextOffset` 并写明「这只是前 2000 字符」。
- **失败长什么样**：`maxChars` 被 clamp 到某个硬编码值（比如恒 20000）而不报错；`fetch_url` 把 2000 当成正文长度、material 里也只存了 2000；或截断了却不说，模型把 2000 当整页总结。
- **判据落点**：
  - `tests/chat/pi/browse-url.test.ts` —— `rejects arguments outside the strict schema`（`prepareArguments` 对空、对多余键都抛）、`posts the url and renders text + links`（`maxChars: 5000` 被断言在请求 body 里）。命令：`npx vitest run tests/chat/pi/browse-url.test.ts`。
  - `tests/agent-runtime/fetch-url-tool.test.ts` —— `fetches an allowed URL and returns the reference structured result`（断言预览恰好 2000 字符、`nextOffset: 2000`、`nextStep` 含 `only the first 2000` / `read_material` / `offset=2000` / `Do not treat this preview as the whole page`）、`omits nextOffset when the whole page fits in the preview`。命令：`npx vitest run tests/agent-runtime/fetch-url-tool.test.ts`。
  - **`maxChars` 的 schema 上下界（1000 / 120000）与默认 40000 暂无自动化判据** —— 现有用例只断言了一个合法值被透传，没断言越界被拒。人工核对方式：`maxChars: 500` 与 `maxChars: 200000` 各调一次，确认都在 `prepareArguments` 抛 `browse_url arguments must match the strict schema.`；不传 `maxChars` 时确认请求 body 里没有该键（由服务端取默认）。
- **两边各自要满足**：
  - 工具层：`browse_url` 只在调用方显式给了 `maxChars` / `waitMs` 时才把它们放进 body（不给就让服务端用自己的默认），不得在工具层塞默认值 —— 否则服务端默认改动时两边会静默不一致。
  - 工具层（`fetch_url`）：`FETCH_PREVIEW_CHARS = 2_000` 是**预览**常量，落库的 markdown 必须是完整抽取结果；`maxBytes`（默认 `5 * 1024 * 1024`）是下载字节上限，与预览字符上限是两个独立的闸，不得互相顶替。
