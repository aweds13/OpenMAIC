# F5 本地课程库 —— 契约

## 这条契约管什么

管「在对话里问『我库里有没有讲 X 的』，然后真的把那一篇读出来」这条路的验收：查得到、查得准、查不到要说查不到、命中之后能整篇读、读不完要能续。

不管索引是怎么建的（BM25 / bge-m3 都在 8720 的 sidecar 里），也不管语料从哪来 —— 只关心**工具这一层的输入、输出与失败形态**。

## 逐条验收

### SR-F5.1 检索必须支持按层级筛选（L0–L4），默认自动选层

- **输入**：`course_search` 的 `layer` 参数。合法取值恒为 `auto` / `L0` / `L1` / `L2` / `L3` / `L4`（`LAYERS`），缺省按 `auto` 处理；`maxResults` 为可选整数 1–12，缺省 6；`query` 必填、非空白、≤ 400 字符。
- **期望**：`layer` 原样进请求 URL 的 `layer=` 查询参数（`{baseUrl}/search?q=&layer=&topk=`），不做本地改写；`auto` 是「自动选层」的显式取值，不是「不带 layer」。非法取值（`L5`、小写 `l4`、数字）在 `prepareArguments` 阶段就被拒，不会打到服务端。目录规模：60072 条（L0 22505 / L1 22048 / L2 242 / L3 232 / L4 34438），3091 份文档 —— 层级不是装饰，是唯一能把「课程目录」与「自己的文档架」分开的参数。
- **失败长什么样**：`layer` 被吞掉、请求里恒为 `auto`；或非法 layer 被静默降级成 `auto` 后返回一堆不相干命中；或把 `L4`（自己的文档）与 `L0`（哪所大学开这门课）混成同一个结果集。
- **判据落点**：**暂无针对 `buildCourseSearchTool` 的参数判据** —— `tests/` 下不存在 `course-search.test.ts`（`docs/implementation/coverage.md:50-51` 引用的那个文件名是错的，仓库里没有这个文件），全仓 `grep -rn "buildCourseSearchTool" tests/` 只命中 `tests/agent-runtime/runner-course-search-registration.test.ts` 里的 `vi.fn()` mock。现存的间接判据：`tests/agent-runtime/course-search-capability.test.ts`（能力门控的五个用例）。人工核对方式：起 8720 后分别用 `layer="L0"`、`layer="L4"`、不传 layer 各查一次同一个词，确认返回结果集不同、且不传 layer 时请求串里是 `layer=auto`；再用 `layer="L5"` 调一次，确认在 `prepareArguments` 抛 `course_search arguments must match the strict schema.` 而不是打到服务端。
- **两边各自要满足**：
  - 工具层（`lib/chat/pi/tools/course-search.ts`）：`LAYERS` 是唯一取值真源；`LAYERS[0]` 必须是 `auto`（默认值从它推）；`prepareArguments` 用 `Value.Check` + `hasStrictArgumentShape` 双保险，`additionalProperties: false` 不得放宽。
  - 注册层（`lib/server/agent-runtime/course-search.ts`）：能力门控只看 `OPENMAIC_COURSE_SEARCH_URL` 是否为 `^https?://`，为空或不符就返回 `null`（**不注册工具**）；不得在注册层改写 `layer` 语义。

### SR-F5.2 检索必须返回可点击定位的结构化命中，不得只回一段散文

- **输入**：一次有命中的 `course_search` 调用。
- **期望**：`details.status === 'ok'`，`details.courses` 是结构体数组，每条至少含 `id / number / title / source / layers / term / units / prereq / description / url / nUnits / nResources / hasMaterials`；块级命中再加 `parentId / chunkIndex / chunkOf / sampled`。给人看的文本里，每条命中必须带能定位的三样：`sourceUrl`、`layers present:`、以及块命中的 `this is chunk N of M` 与 `full document id for read_document: <parentId>`。命中数写在头行 `Local course catalog (N matches, method=…, retrievedAt=…):`。文本末尾必须带那句「只有返回的这些记录是真的，`materials: none` 就不许说有讲义，引用要写 sourceUrl」。
- **失败长什么样**：只返回一段总结性散文（「我找到几门相关的课，比如 MIT 的分布式系统…」），没有 `sourceUrl`、没有 `id`，模型无法引用、也无法接着 `read_document`；或块命中不标 `chunk N of M`，模型把一块当整篇。
- **判据落点**：**暂无自动化判据**（无 `buildCourseSearchTool` 的单元测试，见 SR-F5.1）。人工核对方式：起 8720 查一个必中的词，确认工具返回文本里有 `sourceUrl:` 行与 `Local course catalog (` 头行；再查一个只可能落在 L4 的词，确认出现 `this is chunk` 与 `full document id for read_document:`。
- **两边各自要满足**：
  - 工具层：`details` 与 `content` 必须是**同一批**记录（`courses.length === courseCount`），不得文本里 5 条、details 里 3 条。
  - 注册层：`buildAgentCourseSearchTool` 只替换 `description` 与 `label`，不得改动 `parameters` 或返回结构 —— 换描述是为了让模型选对层，不是为了换形状。

### SR-F5.3 检索不得凭空编造条目；命中为空时必须明说没有

- **输入**：一次零命中的 `course_search`（`hits` 为空数组）；以及一次服务没配 / 服务坏掉的情况。
- **期望**：三种「没有」必须分开说，不得混成一个：
  - 命中为空 ⇒ `details.status === 'no_results'`，文本 `No course in the local catalog matches "<query>"`（带 `layer` 时补 ` at layer <L>`），并提示放宽词或去掉 layer；
  - 未配置 ⇒ `details.status === 'not_configured'`，文本 `Course search is not configured. Do not invent course facts; explain the limitation instead.`；
  - 传输失败 ⇒ `details.status === 'error'`，文本 `Course search is unavailable right now…`，**不得**把原始错误（URL、状态码、堆栈）透进工具历史。
  
  三种情况都返回 `courses: []` 而不是空数组之外的任何编造内容；成功与空命中的文本都必须把「不要编造」写成给模型看的硬约束。
- **失败长什么样**：零命中时返回一句「没找到」却不说是「库里没有」还是「服务没起来」；或零命中时模型自行补出几条看起来合理的课程；或把 `ECONNREFUSED` 原样贴进历史。
- **判据落点**：**`no_results` 路径暂无自动化判据** —— `grep -rln "no_results" tests/` 零命中。`not_configured` / `error` 的**形状**由 `tests/chat/pi/read-document.test.ts` 的 `never reflects a raw transport error into tool history` 与 `tests/chat/pi/browse-url.test.ts` 的同名用例间接代表（同一条约定），但 `course_search` 自己的两个分支没有断言。人工核对方式：起 8720 查一个必然不存在的词（如 `zzzqqq-nothing`），确认 `status === 'no_results'` 且文本里出现 `No course in the local catalog matches`；再把 `OPENMAIC_COURSE_SEARCH_URL` 指到一个死端口，确认回 `error` 且文本里不含 `ECONNREFUSED`。
- **两边各自要满足**：
  - 工具层：三个分支的 `status` 值必须严格是 `no_results` / `not_configured` / `error`，不得用 `ok` + 空数组表示「没有」。
  - 提示词层：`buildAgentCourseSearchTool` 替换后的描述里必须写明「只引用返回的记录、`materials: none` 不许说有讲义」（`tests/agent-runtime/runner-course-search-registration.test.ts` 断言了 `## Local library and the web are complementary` 块会被注入，且**不能**出现「优先用本地」把联网降级的写法）。

### SR-F5.4 命中后必须能把整篇文档读出来，不受预览上限约束

- **输入**：`read_document`，`mode` 只能是 `peek` 或 `full`（`DOC_MODES`）；`id` 为 `course_search` 返回的 `parentId`；`offset` ≥ 0；`limit` 为 1–60000 的整数，缺省即上限 60000。
- **期望**：`peek` 只给「开头 2000 字符 + 每块首句（最多 40 条）+ 总长度」，并在末尾明说「这只是预览，要用就再调 `mode="full"`」；**`full` 给正文**，单次最多 60000 字符，头行写 `chars <offset>–<offset+returned> of <total>` —— 这行是「不受预览上限约束」的可核查证据。`offset` / `limit` 只在 `full` 时进请求。
- **失败长什么样**：`full` 也只回 2000 字符且不说被截断；`peek` 与 `full` 返回同一份内容（那就等于没有全文能力）；或者把 `limit` 上限写得比预览上限还小。规模依据：预览恒 2000 字符，正文平均 17443 字符 —— 只看预览等于只读了 11%。
- **判据落点**：`tests/chat/pi/read-document.test.ts` —— `peek asks the /document endpoint and surfaces a rough table of contents`（断言 `mode=peek`、`Rough contents`、以及**必须**出现 `mode="full"` 这句提示）、`full forwards offset/limit and reports paging when there is more`（断言 `mode=full`、`offset=800`、`limit=400` 都在 URL 里）。命令：`npx vitest run tests/chat/pi/read-document.test.ts`。
- **两边各自要满足**：
  - 工具层：`peek` 的 2000 是**硬切**（`slice(0, 2000)`），`full` 的 60000 是**schema 上限**（`maximum: 60000`），两个数不得共用一个常量。
  - 服务层（8720 的 `/document`）：`peek` 返回 `preview / previewTruncated / toc`，`full` 返回 `text / offset / returned / hasMore / nextOffset`；两种形状不得混用（工具按 `mode` 决定读哪组字段）。

### SR-F5.5 取全文必须支持分页/续读，且必须给出续读指针或明说读完

- **输入**：`read_document(mode="full")` 的一次调用，文档长于本次 `limit`（或长于默认 60000）。
- **期望**：响应里的 `hasMore` 为 `true` 时，`nextOffset` 必须是**可用的下一个起点**（= `offset + returned`，或服务给的等价物），而且这句指针必须同时出现在两个地方：`details.nextOffset`（给人看的结构化字段）与文本里的 `…(more available; call again with offset=<N>)`。`hasMore` 为假时**不得**给 `nextOffset`，文本里也不得出现这句 —— 「明说读完」= 没有续读指针。
- **失败长什么样**：返回了 `nextOffset` 但下游没有任何工具接收它（历史缺陷：`nextOffset` 曾是死指针）；或 `hasMore: true` 却只回一句「内容较长」，模型不知道从哪接着读；或读完了仍给一个指向文末的指针，让模型空转。
- **判据落点**：`tests/chat/pi/read-document.test.ts` —— `full forwards offset/limit and reports paging when there is more`（断言 `details.hasMore === true`、`details.nextOffset === 1200`，且正文文本里含 `offset=1200`）。命令：`npx vitest run tests/chat/pi/read-document.test.ts`。
- **两边各自要满足**：
  - 工具层：`nextOffset` 只能在 `hasMore` 为真时出现，两个字段必须同进同退；指针要写进**文本**，不能只放 `details` —— 模型读的是文本。
  - 服务层：`returned` 必须真实（= 本次实际返回字符数），`nextOffset = offset + returned`；不得用「请求的 limit」代替「实际返回」。
