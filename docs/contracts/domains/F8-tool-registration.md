# F8 工具注册与提示词口径 —— 契约

## 这条契约管什么

管「模型手里到底有哪些工具、提示词里点名的名字是不是真的装出来了」这条路的验收：能力没配就不注册、注册了名字才能进提示词与允许表、外部 MCP 连不上只记失败不拖死会话、同一能力在三个注册点上口径一致。

不管工具内部怎么实现、参数 schema 写得多细（那是各工具自己的事与 `conventions.md` §四）。只关心**注册面、允许表、提示词三处是否同源**。

## 逐条验收

### SR-F8.1 外部 MCP 连不上时必须只记录失败，不得注册其工具、不得阻塞会话

- **输入**：`OPENMAIC_MCP_SERVERS` 指向一个不存在的服务（错误的端口或错误的主机名），同时开一场普通会话。

- **期望**：会话正常开始、正常回话。那个服务器的工具一个都不出现在工具表里，允许表里也没有；提示词里不提它的名字（`mcpPromptBlock` 在名字为空时返回空串，`lib/server/agent-runtime/mcp-tools.ts:118-120`）。失败被记下来并打日志：`listMcpTools()` 把连不上的服务器推进 `failed`，同时 `log.warn(\`MCP server "<name>" unavailable: <message>\`)`（`lib/server/agent-runtime/mcp-client.ts:190-220`），`buildMcpTools()` 永远不会抛（`mcp-tools.ts:90-108` 的头注释就写着这条）。`OPENMAIC_MCP_SERVERS` 本身是一段坏 JSON 时同理：`resolveMcpServers()` 一律回 `{}`，MCP 像没开一样消失。

- **失败长什么样**：一个 MCP 服务器没起，整场会话起不来（抛穿到路由层）；或者工具照样注册了，模型一调就回 `MCP server "x" unavailable`；或者失败什么都不记，运维只能从「模型怎么不用那个工具」反推。

- **判据落点**：**暂无自动化判据** —— `tests/` 里没有任何文件导入或 mock `mcp-tools` / `mcp-client`（`grep -rln "mcp" tests/` 的命中只有 `tests/agent-runtime/compaction.test.ts`、`tests/agent-runtime/course-design-prompt.test.ts`、`tests/agent-runtime/prompt-audit-live.test.ts`、`tests/agent-runtime/study-mode-density.test.ts`，全都是断言「提示词里**不许**出现 `mcp__github` 这类名字」，没有一条测连接失败）。`docs/implementation/coverage.md` 给这条写的落点 `tests/agent-runtime/mcp-*.test.ts` **不存在**，以本节为准。人工核对方式：把 `OPENMAIC_MCP_SERVERS` 指到一个必然连不上的地址（例如 `{"dead":{"command":"definitely-not-a-real-binary"}}`），起会话跑一轮，确认三件事 —— (a) 会话有正常回复；(b) 工具表里没有该服务器前缀的工具名；(c) 服务端日志里有一行 `MCP server "dead" unavailable: …`。

- **两边各自要满足**：
  - 宿主侧：`buildMcpTools()` 必须吞掉所有异常并降级成空工具集；不许把 `failed` 当成致命错误往上抛。`failed` 目前**没有消费者**（`grep mcp.failed` 全仓零命中），失败只活在 `mcp-client` 内部的 `log.warn` 里 —— 这是当前实现，不是理想态；要判定「记下来了」，只能看日志。
  - 部署侧：`OPENMAIC_MCP_SERVERS` 里引用 `$NAME` 形式的凭据时，变量缺了必须**拒绝启动那个服务器**而不是用空凭据去连（`mcp-client.ts:102-120` 抛的是 `Refusing to start the server with an empty credential.`），这也算「只记录失败」的一种。

### SR-F8.2 未配置的能力不得注册工具

- **输入**：`OPENMAIC_COURSE_SEARCH_URL` / `OPENMAIC_BROWSE_URL` 不设（或设成空串）时的会话；对照组是设了的时候。

- **期望**：能力不在，那一组工具**一个都不注册** —— 不是「注册了但一调就 `not_configured`」。课程检索配了就必须同时注册 `read_document`（它是配套的，不是可选项：`course_search` 的 L4 命中只是一个「块」，没有 `read_document` 就成了「查得到第 12 块，但翻不开这本书」，`lib/server/agent-runtime/runner.ts:1535-1543` 的注释）。同理技能工具、语音工具、web search 工具各自按能力有无决定。允许表是从真装出来的工具派生的，所以这条同时保证了允许表里也没有。

- **失败长什么样**：模型手里有一把「在工具表里、一调就 `not_configured`」的死工具 —— 它会去调，然后浪费一轮并把这轮的错误结论带进上下文。仓库里真发生过：某个注册点曾经无条件注册，导致上游 9 条断言一起红（`docs/specification/domains/F8-tool-registration.md` 记的来历）。

- **判据落点**：`tests/agent-runtime/runner-course-search-registration.test.ts` —— `registers course_search AND read_document with their prompt block when a local library is configured` / `registers no library tools and no prompt block when the library is unconfigured`；`tests/agent-runtime/runner-web-search-registration.test.ts` —— `registers both tools and the web-search prompt block when a backend is configured` / `registers ask_user and the skill tools, but no web-search prompt, when nothing is configured`；`tests/agent-runtime/runner-voice-registration.test.ts` —— `registers clip_audio but not register_voice when no adapter supports registration`（3 例里 2 例是这条）；`tests/agent-runtime/browse-url-capability.test.ts` 的 `describe('resolveBrowseCapability')`（`is null when unset or blank` / `rejects a value that is not an http(s) URL`）。命令：`npx vitest run tests/agent-runtime/runner-course-search-registration.test.ts tests/agent-runtime/runner-web-search-registration.test.ts tests/agent-runtime/runner-voice-registration.test.ts tests/agent-runtime/browse-url-capability.test.ts`。

- **两边各自要满足**：
  - 宿主侧（`runner.ts`）：能力解析器（`resolveCourseSearchCapability()` / `resolveBrowseCapability()` / `resolveWebSearchCapability()`）返回 `null` 时，那一组必须是**空数组**再进 `assembleRunnerTools`，不许塞一个永远失败的占位实现。
  - 能力解析器本身：空串（`''` / 只有空白）必须等同于「没配」，不许当成一个合法的 baseUrl 往下传 —— 否则注册了、请求打到空地址，又变回死工具。

### SR-F8.3 未注册的工具名不得出现在提示词与允许表里

- **输入**：任意一组能力组合下的装配结果 —— 工具数组、允许表、系统提示词三者同时取出。

- **期望**：提示词里出现的每一个工具形状的名字（`` `word_with_underscore` `` 这种），都必须在**真正装出来的工具名集合**里；允许表必须是从工具数组派生的，不是手写第二遍（`lib/server/agent-runtime/runner.ts:2022` 的 `allowedToolNames: new Set(tools.map((tool) => tool.name))`，注释就写着「★ 允许表**从真正装出来的工具派生**，不再手写第二遍」）；提示词里提到的**参数名**也必须是那些工具真的声明过的参数。子代理侧同理：`availableToolNames` 原样进子代理提示词，所以它只能等于真装出来的那一组。

- **失败长什么样**：提示词里点名 `analyze_course_history`（这个工具早改名了），模型照着调，得到「未注册」；或者允许表是手写的一份常量，跟工具数组漂移，于是「装上了但不许调」；或者子代理提示词列了 3 个工具、`availableToolNames` 只有 2 个。

- **判据落点**：`tests/agent-runtime/_tool-name-tokens.ts` 提供抽取器（`toolLikeTokens` / `phantomToolNames` / `paramLikeTokens` / `declaredParamNames` / `calledToolTokens`），`tests/agent-runtime/runner-course-search-registration.test.ts` 的 `★ assembled prompt names no unregistered tool`（2 例）与 `★ assembled prompt: every capability combination`（1 例覆盖 8 种能力组合，同时查幽灵工具名、幽灵参数、被调用的幽灵名，并断言 `blocked` 为空）；`tests/agent-runtime/tool-name-invariant.test.ts` 6 例（其中 `the extractor actually finds tool-shaped names (else the checks above are vacuous)` 是防止这条测试退化成空转的）；允许表派生关系由 `tests/agent-runtime/personal-history-runner-wiring.test.ts` 钉 —— 它 `readFileSync` 读 `lib/server/agent-runtime/runner.ts` 源码，断言里面有 `allowedToolNames: new Set(tools.map((tool) => tool.name))` 这个字面量。子代理侧：`tests/lib/chat/pi/native-child-consumer.test.ts`（38 例）里 `expect(second.details).toMatchObject({ availableToolNames: ['spotlight','web_search'] })`；`tests/lib/agent/runtime/run-native-child.test.ts` 的 `charges an unauthorized registered call without entering its handler`（允许表为空时连 handler 都不进）。命令：`npx vitest run tests/agent-runtime/runner-course-search-registration.test.ts tests/agent-runtime/tool-name-invariant.test.ts tests/agent-runtime/personal-history-runner-wiring.test.ts tests/lib/chat/pi/native-child-consumer.test.ts tests/lib/agent/runtime/run-native-child.test.ts`。

- **两边各自要满足**：
  - 宿主侧：允许表只能有一处派生点。任何「先手写一份白名单、再和工具数组对一遍」的写法都属于违反 —— 两份清单一定会漂移，而且漂移时不会有测试红。
  - 提示词侧：工具描述里不许提别的工具名（`tests/agent-runtime/browse-url-capability.test.ts` 的 `never names a tool this deployment may not have registered` 就是这条的工具级落地）；能力块的出现条件必须与注册条件同源。
  - 子代理侧：`availableToolNames` 必须就是 `nativeTools.map(t => t.name)`，不许另外拼一份。

### SR-F8.4 同一能力在多处注册点必须同一口径（配置在则有，配置无则无）

- **输入**：同一份部署配置（`OPENMAIC_COURSE_SEARCH_URL` / `OPENMAIC_BROWSE_URL` 在或不在），分别走三个注册点：主运行面（`lib/server/agent-runtime/runner.ts`）、会话接口（`app/api/chat/pi/route.ts`）、子代理装配（`lib/chat/pi/tools/call-agent.ts`）。

- **期望**：三处判据完全相同 —— 配了就有、没配就没有。`lib/chat/pi/tools/call-agent.ts:793-801` 的注释把这条写死了：「能力注册，不是开关 —— 与 `runner.ts`、`app/api/chat/pi/route.ts` 三处同一条口径：**没配这个服务就不注册这个工具**」；三处的代码形状也一致：`...(opts.courseSearchConfig ? [buildCourseSearchTool(...), buildReadDocumentTool(...)] : [])`、`...(opts.browseConfig ? [buildBrowseUrlTool(...)] : [])`。会话接口侧还多一个条件：只有子运行时是 `native` 时才按能力注册（`app/api/chat/pi/route.ts:285-291`）。

- **失败长什么样**：主运行面不注册、会话接口注册 —— 于是同一个能力在「直连」与「走 pi 会话」两条路上表现不同，用户看到的是「有时能用有时不能用」。或者三处都注册，但只在其中一处带 `read_document` 这个配套工具。另有一种历史遗留：`app/api/chat/pi/route.ts:280-282` 的注释至今仍写着「Unset keeps the tool registered but answering `not_configured`」，与它下方 `:284-291` 的代码（没配就是 `undefined`、不注册）**互相矛盾** —— 注释漂移本身也算一种口径不一致，读代码的人会被它带偏。

- **判据落点**：主运行面有测试：`tests/agent-runtime/runner-course-search-registration.test.ts` 的 `course_search runner registration` 2 例 + `browse_url runner registration` 3 例。**另两处暂无自动化判据** —— `grep -rn "courseSearchConfig\|readDocumentConfig\|browseConfig" tests/` 零命中，`OPENMAIC_COURSE_SEARCH_URL` 在 `tests/` 里零命中；`tests/` 里导入 `app/api/chat/pi/route.ts` 的 9 个文件测的都是别的事（模型优先级、owner cookie、元素引用等），没有一条断言能力注册。人工核对方式：以「配了 / 没配」两种 env 各起一次服务，在三条路径上分别问模型「你有哪些和课程检索、网页抓取有关的工具」，并对照 `GET /api/whoami` 的能力回显，三处答案必须同进同退。

- **两边各自要满足**：
  - 三处代码：判据表达式必须能一眼对上（同名的 `courseSearchConfig` / `browseConfig` 由 env 解析成 `undefined | {baseUrl}`），不许各自发明一套开关（例如一处看 env 非空、另一处看一个 `enabled` 布尔）。
  - 配套关系：`read_document` 必须永远跟 `course_search` 同进同退，三处都不许只注册其中一个。
  - 注释：注释里描述的行为必须与下一行代码一致；口径改了要连注释一起改，否则它会在下一次重构时把人带回去。
