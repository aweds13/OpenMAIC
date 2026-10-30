# F7 会话上下文与材料 —— 契约

## 这条契约管什么

管「一次 agent 运行看到了什么上下文」这条路的验收：会话材料怎么进模型（不进系统提示词、由工具按需读）、系统提示词在会话内是否逐字节稳定、原生压缩在预算触顶时到底有没有真的发生、预算这个旋钮按什么口径算。

不管材料怎么抽取（那是 F5 与抽取流水线的事），也不管提示词里每一段文案写成什么样 —— 只关心**模型的输入在什么条件下会变、变了会不会毁掉前缀缓存、以及「压缩发生了」这件事能不能被读出来**。

## 逐条验收

### SR-F7.1 材料/画像的修改必须在下次会话生效，不得要求重启进程

- **输入**：两条独立的改动路径 —— (a) 改 `OPENMAIC_LEARNER_PROFILE_PATH` 指向的那份 Markdown 的内容（补掌握度、改目标）；(b) 给一个已有会话挂上或换掉材料（web / pdf / pptx）。

- **期望**：下一次运行立刻读到新内容，**进程不重启**。画像在每次运行里重读（`lib/server/agent-runtime/runner.ts:1554` 的 `const learnerProfile = resolveLearnerProfile();`），材料在每次运行里重读（`lib/server/agent-runtime/runner.ts:1748` 的 `const materials = await listSessionScopeMaterials(id);`）—— 两处都不跨运行缓存解析结果。有一条边界必须同时成立、也必须说清：**内容**改了不用重启，**路径**（env 值）改了要重启 —— 路径跟这个文件里其它配置一样在模块加载时求值，`lib/server/agent-runtime/config.ts:101-103` 把这两个生命周期写成了两行注释。

- **失败长什么样**：改完画像，下一次运行用的还是旧内容（读一次就缓存住了）；或者反过来，把「换路径」也做成热更新，于是 `GET /api/whoami` 回显的 `learnerProfilePath` 与真正在读的路径对不上；或者材料已经写进会话，下一次运行 `list_materials` 还是空。

- **判据落点**：`tests/agent-runtime/learner-profile.test.ts` —— `re-reads the content on every call (editing the file needs no restart)`（同一路径连续两次调用，第二次读到改后的内容；这是全 `tests/` 里唯一直接钉住「不用重启」的断言）。材料侧：`tests/agent-runtime/session-materials.test.ts` —— `persists a fetched page as a web material linking its object key, and reads it back`。命令：`npx vitest run tests/agent-runtime/learner-profile.test.ts tests/agent-runtime/session-materials.test.ts`。**「新会话读得到上一个会话挂的材料」这一半暂无自动化判据**（`docs/implementation/coverage.md` 对这条标的是「松」）；人工核对方式：先 `curl http://127.0.0.1:<port>/api/whoami` 确认 `learnerProfilePath` / `materialsDir` 是你要改的那两个，再起一个新的会话问 `list_materials`，看它列不列得出上一轮挂的东西。

- **两边各自要满足**：
  - 宿主侧（`lib/server/agent-runtime/`）：resolver 每次运行都调，不许在模块作用域里把解析结果存下来；env 值可以只在加载时读，但必须能从 `/api/whoami` 读回来核对，否则「改了没生效」就只能靠猜。
  - 文件侧（画像 / 材料库）：写入必须先落盘或先提交事务，再让下一次运行开始读；不许「先应答、后落盘」—— 下一次运行可能就发生在落盘之前。

### SR-F7.2 会话级材料内容不得写入系统提示词

- **输入**：一个挂了材料的会话 —— 材料可以是 `web`（抓来的网页）、`pdf`、`pptx`，抽取状态可以是 `idle` / `running` / `done` 任意一种。

- **期望**：材料块（`materialsPromptBlock`）**只给一张固定的地图**：怎么用 `list_materials` 的 `scope: 'library'` 看这个会话有什么、按什么顺序等抽取（抽出 → 等 → 读）、怎么直接读 `web` 材料、`import_pptx` 是保版面的。这一段与「这个会话到底挂了什么」无关：不出现材料名、id、类型、抽取状态、正文片段、条数。真实材料由工具在每次调用时去 store 里现读。`lib/server/agent-runtime/material-prompt.ts:20` 把参数写成 `_materials: readonly ResolvedMaterial[]` 并在注释里明写「The block must not read it」，就是这个意思。

- **失败长什么样**：系统提示词里出现 `lesson.pdf`、`mat_web`、`src_lesson`、`extraction done` 这类只有这个会话才知道的东西；或者出现「Attached to this conversation: …」这种把集合渲染出来的句式。另一种更隐蔽的失败：把材料正文塞进「附件说明」而不是工具结果里 —— 看着像没进系统提示词，其实进了。

- **判据落点**：`tests/agent-runtime/prompt-prefix-cache.test.ts` 三例 —— `keeps the system prompt byte-identical when the material set changes`（遍历材料集逐字节比对）、`names nothing from the set and still points at list_materials and the knowledge base`（正面要求含 `## Materials and the knowledge base` 与 `list_materials lists what this conversation has`，反面逐个断言不含那 12 个泄漏字符串）、`leaves discovery to list_materials, the attachment note, and the fetch_url result`（这一条同时钉住了「附件说明可以点名，但只能带名字/类型/字节数，不许带对象存储的 key」）。命令：`npx vitest run tests/agent-runtime/prompt-prefix-cache.test.ts`。

- **两边各自要满足**：
  - 宿主侧：材料块必须是常量字符串 —— 参数留着是为了将来能改签名，不是为了现在能读它；一旦有人开始读，这条契约立刻失守。
  - 工具侧：`list_materials`（`lib/server/agent-runtime/material-tools.ts:615`）必须每次真的去读 store，不许把「上次读到的清单」缓存进提示词那一段来省一次调用。

### SR-F7.3 系统消息必须在同一会话内逐字节稳定（缓存友好）

- **输入**：同一会话里材料集发生变化 —— 从「什么都没挂」到「挂了一件并抽完」，再到「多挂一件」；以及同一会话的第 1 轮与第 N 轮。

- **期望**：`systemPrompt` 逐字节相同（不是「语义相同」，是 `toBe` 相等）。同一会话里唯一允许变的那一块是学习者状态（答题后变），所以它必须排在**最后**（`lib/server/agent-runtime/runner.ts:1994-1995` 的注释：前缀缓存按前缀算，它后面没有别的块，变一次只让这一小段重读）。同时**存量 transcript 也必须保持 provider-message 前缀**：新加一条预载工具结果只能往后追加，不能重写前面已经发过的请求。

- **失败长什么样**：挂上一件材料，命中率从 99.1% 掉到 38.5%（`docs/intention/needs.md:102` 记的实测）；或者每轮都在提示词里塞一个时间戳/条数，看着无害，其实每轮全量重读。实测基线：材料移出系统提示词之后，同一套操作 91.0% → 连续 12 次调用 99.6–100%。

- **判据落点**：`tests/agent-runtime/prompt-prefix-cache.test.ts` —— `keeps the system prompt byte-identical when the material set changes`（`expect(systemPrompt(materials)).toBe(baseline)`，且 `extractionIdle === extractionDone`）；`stored transcripts stay a provider-message prefix` 下的 `extends [user] with a preload tool result without rewriting the earlier request`。命令：`npx vitest run tests/agent-runtime/prompt-prefix-cache.test.ts`。运行期核对方式（人工）：`OPENMAIC_DEBUG_PROMPT_FINGERPRINT=1` 起服务，每轮会打出逐块 `[prompt-fingerprint]` 哈希 —— 材料变化时这些哈希必须一个都不变；再对照 `data/usage/*.jsonl` 里的 `cacheReadTokens`，稳定后应当在 99% 以上。

- **两边各自要满足**：
  - 宿主侧：`buildPromptBlocks()` 里每一块的**出现条件**只能是部署级配置（能力在不在），不能是会话级状态（挂了几件材料）；顺序也不能随手调 —— 会变的那块必须在末尾。
  - 模型侧（provider 适配层）：发出去的 system 消息体不许做「压缩空白 / 重排 JSON / 补默认值」这类规范化，否则字节就变了。

### SR-F7.4 原生压缩必须在预算触顶时真的发生，不得空转

- **输入**：`OPENMAIC_AGENT_COMPACTION_ENABLED=true`，预算取默认 150000，transcript 长到超过预算；对照组是同一个 transcript、同一个预算、压缩关着。

- **期望**：开着时 `triggerCount > 0`：写入一条 compaction entry，上下文**真的变小**；关着时 `checkCount` 与 `triggerCount` 恒为 0（`lib/server/agent-runtime/compaction.ts:315-327` 在 `if (!settings.enabled) return trace;` 之后才有计数）。另有一条独立入口：`/compact` 是本回合消息里的文本命令，绕过阈值，且在自动压缩关掉的部署里也生效（`lib/server/agent-runtime/runner.ts:1477-1483`）。

- **失败长什么样**：预算拿模型目录窗口（有些是 1M）当判据，于是永远不触发 —— 这是这个旋钮出现前的实况。另一种更坏：预算低于固定开销，每轮都压、每轮都更大。实测记录在 `lib/server/agent-runtime/compaction.ts:81-87`：6000 的预算连打四轮，输入 token 是 23,030 → 24,565 → 26,181 → 27,831，只涨不跌。还有第三种：压缩失败了却把整场运行判死。

- **判据落点**：`tests/agent-runtime/compaction.test.ts` —— `does nothing at all when compaction is disabled` / `leaves the transcript untouched while under budget` / `writes a compaction entry and shrinks the context when over budget` / `records a summarization failure without failing the run` / `compacts on request even with a budget it would never cross`。`tests/agent-runtime/compaction-stale-anchor.test.ts` —— `maybeCompactAgentSession reports the real saving` / `does not re-compact a context it just shrank`（刚压完不许立刻再压一次）。命令：`npx vitest run tests/agent-runtime/compaction.test.ts tests/agent-runtime/compaction-stale-anchor.test.ts`。

- **两边各自要满足**：
  - 宿主侧：`maybeCompactAgentSession` 不许在失败时抛穿 —— 压缩是优化，不是正确性前提；`triggerCount > 0` 时必须把事件带出来（`LIFECYCLE.trace`），否则「到底压没压」在运行期看不见。
  - 观测量侧：`estimateAgentContextTokens` 优先用 provider 上一轮报的 usage（那是整个请求的量：transcript + system prompt + 工具定义）；只有在 provider 没报 usage，或最新那条 compaction 比该消息还新（`usageAnchorIsStale`）时，才退化成只估消息 —— 否则压缩完的下一轮会拿一个过期的量再压一次。

### SR-F7.5 压缩预算必须按可用窗口配置，且必须大于固定开销

- **输入**：四类预算值 —— 默认（不设 env）、极小（如 100）、正常（如 150000）、以及用 `OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS` / `OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS` 显式覆写。

- **期望**：reserve 与 keep 由**预算**派生，不由模型窗口派生：`reserveTokens = min(默认, max(2048, floor(budget × 0.25)))`、`keepRecentTokens = min(默认, max(2048, floor(budget × 0.34)))`（`lib/server/agent-runtime/compaction.ts:174-199`）；预算小到 100 时两者都落到 2048 下限，仍给摘要模型留出空间。默认预算是 150000（`lib/server/agent-runtime/config.ts:18`），系统提示词 + 工具定义这一坨固定开销约 23k，所以默认值约是它的 6 倍 —— 这个 6 倍关系是「预算只有明显高于固定开销才有意义」的落点。

- **失败长什么样**：`reserveTokens` / `keepRecentTokens` 跟着模型窗口走，换一个 1M 窗口的模型就再也不触发；或者预算设成 6000（低于 23k 固定开销）还开着压缩，于是每轮都触发、每轮都更大。

- **判据落点**：`tests/agent-runtime/compaction.test.ts` —— `derives reserve and keep from the budget, not from the model window`（断言 `reserveTokens <= 150_000` 且 `keepRecentTokens <= 150_000`）、`floors both values so a tiny budget still leaves the summarizer room`（预算 100 → 两者都是 2_048）、`lets the operator override either value, including enabled`。命令：`npx vitest run tests/agent-runtime/compaction.test.ts`。**「预算 > 固定开销」这个不等式本身暂无自动化判据** —— 测的是「从预算派生」与「有下限」，不是「比 23k 大」；人工核对方式：`curl http://127.0.0.1:<port>/api/whoami` 读 `compactionContextBudgetTokens` 与 `compactionEnabled`（这两个值在 `/api/whoami` 里是原样回显的），确认它明显大于 23k 再开压缩。

- **两边各自要满足**：
  - 宿主侧：env 解析必须能区分「没设」与「设成 0」—— 没设走默认 150000，设成不合法的值不许静默变成 0（0 会让下限 2048 生效，看起来像在工作，其实什么都没省）。
  - 运维侧：预算只能配在部署层（env），不许做成每请求可调 —— 一旦每请求可调，前缀缓存就没法指望了。
