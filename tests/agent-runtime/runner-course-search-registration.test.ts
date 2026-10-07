/**
 * Runner-level pins for capability-registered `course_search` wiring.
 *
 * 姊妹文件 runner-web-search-registration.test.ts 覆盖 web_search；这个文件
 * 覆盖**本地课程库**那条线：把 8720 上的课程目录 + 文档架接进 agent 会话。
 *
 * 为什么必须单独钉：
 *   在接这条线之前，agent-runtime 跟课程库**零关联**（全目录 grep 无命中），
 *   所以「注册了没有」完全取决于 OPENMAIC_COURSE_SEARCH_URL 有没有配。
 *   两类回归都会静默发生：
 *     · 能力配了但工具没注册 → 模型永远看不到本地材料，只会去 web_search；
 *     · 能力没配但 prompt 块还在 → 模型读到一段描述不存在工具的指引。
 *   这两种都不会报错，只会让产出悄悄变差 —— 所以钉在 runner 层。
 *
 * 与 web_search 测试的分工：那边逐项列出完整工具名单（抓意外增删），
 * 这里只断言**包含/不包含**，避免每次加工具都要改两处名单。
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
  resolveCourseSearchCapability: vi.fn(),
  resolveLearnerProfile: vi.fn(),
  buildCourseSearchTool: vi.fn(),
  listSessionMaterials: vi.fn(async () => []),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: mocks.listSessionMaterials };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: { open: mocks.openEntryStorage },
  };
});

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

// web_search 与本文件无关，钉成"未配置"，免得它混进工具名单。
vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return { ...actual, resolveWebSearchCapability: mocks.resolveWebSearchCapability };
});

// ★ 只替换能力解析与底层工具的构造，**保留真的 prompt 块和工具封装**，
//   这样断言观察到的是真实注册结果，不是 mock 的返回值。
vi.mock('@/lib/server/agent-runtime/course-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/course-search')>();
  return {
    ...actual,
    resolveCourseSearchCapability: mocks.resolveCourseSearchCapability,
    buildAgentCourseSearchTool: mocks.buildCourseSearchTool,
  };
});

vi.mock('@/lib/server/agent-runtime/learner-profile', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/learner-profile')>();
  return { ...actual, resolveLearnerProfile: mocks.resolveLearnerProfile };
});

vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { runSession } from '@/lib/server/agent-runtime/runner';
import { phantomToolNames } from './_tool-name-tokens';

const SESSION_ID = 'session-1';
const WORKER_ID = `runner-t:${process.pid}`;

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Help me',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(async () => {
      seq += 1;
      return seq;
    }),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

function makeFakeAgent() {
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    subscribe: (l: (event: AgentEvent, signal?: AbortSignal) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    prompt: async () => {},
    continue: async () => {},
    waitForIdle: async () => {},
    steer: (_m: AgentMessage) => {},
    abort: () => {},
    state: { messages: [] as AgentMessage[], errorMessage: undefined },
  };
}

interface BuildAgentOptions {
  systemPrompt: string;
  tools: Array<{ name: string }>;
  allowedToolNames?: ReadonlySet<string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessionMaterials.mockResolvedValue([]);
  // web_search 一律未配置：本文件只关心课程库。
  mocks.resolveWebSearchCapability.mockReturnValue(null);
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.buildAgent.mockReturnValue(makeFakeAgent() as never);
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
  mocks.buildCourseSearchTool.mockReturnValue({ name: 'course_search' } as never);
});

async function runToBuildAgent(): Promise<BuildAgentOptions> {
  const meta = makeMeta();
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: SESSION_ID });
  const store = makeStore(meta);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    return makeFakeAgent();
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  return options!;
}

describe('course_search runner registration', () => {
  it('registers course_search AND read_document with their prompt block when a local library is configured', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue({ baseUrl: 'http://127.0.0.1:8720' });

    const options = await runToBuildAgent();
    const names = options.tools.map((t) => t.name);
    const allowed = [...(options.allowedToolNames ?? [])];

    expect(names).toContain('course_search');
    // read_document 必须一起去：course_search 的 L4 命中只是一个「块」，
    // 没有 read_document 就无法展开成整篇 —— 命中之后无法跟进。
    expect(names).toContain('read_document');
    // 工具单独在表里不够 —— allowlist 也必须放行，否则调用会被拒。
    expect(allowed).toContain('course_search');
    expect(allowed).toContain('read_document');
    expect(options.systemPrompt).toContain('## Local library and the web are complementary');
    expect(options.systemPrompt).toContain('L4');
    expect(options.systemPrompt).toContain('read_document');
    // ★ 反向断言：提示词里**不能**出现"优先用本地"这种把联网降级的说法。
    //   本地库没有 GitHub 开源项目，写成二选一会让模型拿不相干的讲义顶替。
    expect(options.systemPrompt).not.toMatch(/[Pp]refer this over `?web_search/);
  });

  it('registers no library tools and no prompt block when the library is unconfigured', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);

    const options = await runToBuildAgent();
    const names = options.tools.map((t) => t.name);
    const allowed = [...(options.allowedToolNames ?? [])];

    expect(names).not.toContain('course_search');
    expect(names).not.toContain('read_document');
    expect(allowed).not.toContain('course_search');
    expect(allowed).not.toContain('read_document');
    // 没工具就不能有指引：一段描述不存在工具的 prompt 会让模型去调一个
    // 它没有的能力，比不给指引更糟。
    expect(options.systemPrompt).not.toContain('## Local library and the web are complementary');
  });
});

/**
 * 学习者画像的 runner 层注册。跟课程库共用同一套脚手架所以放在这里 ——
 * 两者都属于"这个部署配了什么，就注入什么"的同类能力。
 */
describe('learner profile runner registration', () => {
  it('injects the profile block when a profile resolves', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);
    mocks.resolveLearnerProfile.mockReturnValue('## 目标\n\n- 成为专家\n');

    const options = await runToBuildAgent();

    expect(options.systemPrompt).toContain('## Learner profile');
    expect(options.systemPrompt).toContain('成为专家');
  });

  it('injects no profile block when nothing resolves', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);
    mocks.resolveLearnerProfile.mockReturnValue(null);

    const options = await runToBuildAgent();

    // 读不到就整段消失，而不是留一个空标题 —— 一个 "## Learner profile"
    // 下面什么都没有，比不注入更容易让模型瞎猜。
    expect(options.systemPrompt).not.toContain('## Learner profile');
  });
});

/**
 * `browse_url` 的 runner 层注册。
 *
 * 跟课程库同属"这个部署配了什么，就注册什么、就注入什么"的同类能力，所以共用
 * 这套脚手架。区别是它的能力判据直接读 `OPENMAIC_BROWSE_URL`（没有单独的
 * mock 缝），所以这里用真实的 env；`tests/setup-env.ts` 保证默认不加载
 * `.env.local`，测试因此是隔离的。
 *
 * 这个 pin 值得存在的原因是实测出来的：浏览器 sidecar 一直在 8730 上跑、
 * `OPENMAIC_BROWSE_URL` 也一直配着，但工作台**从来没有**这个工具 ——
 * 配置存在和工具存在是两件事，只有 runner 层的断言能把它们绑在一起。
 */
describe('browse_url runner registration', () => {
  const PREV_BROWSE = process.env.OPENMAIC_BROWSE_URL;

  afterAll(() => {
    if (PREV_BROWSE === undefined) delete process.env.OPENMAIC_BROWSE_URL;
    else process.env.OPENMAIC_BROWSE_URL = PREV_BROWSE;
  });

  it('registers browse_url and its prompt block when a browser service is configured', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);
    mocks.resolveLearnerProfile.mockReturnValue(null);
    process.env.OPENMAIC_BROWSE_URL = 'http://127.0.0.1:8730';

    const options = await runToBuildAgent();
    const names = options.tools.map((t) => t.name);
    const allowed = [...(options.allowedToolNames ?? [])];

    expect(names).toContain('browse_url');
    // 工具在表里不够 —— allowlist 也必须放行，否则调用会被拒。
    expect(allowed).toContain('browse_url');
    expect(options.systemPrompt).toContain('## Reading the web: look with the browser');
    // 提示词必须把「看」和「存」分开：只说优先用浏览器，模型会读完就走，
    // 内容没落成 material，后面的精读和页面生成都引用不到。
    expect(options.systemPrompt).toContain('fetch_url');
    expect(options.systemPrompt).toContain('read_material');
  });

  it('registers no browser tool and no prompt block when the service is unconfigured', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);
    mocks.resolveLearnerProfile.mockReturnValue(null);
    delete process.env.OPENMAIC_BROWSE_URL;

    const options = await runToBuildAgent();
    const names = options.tools.map((t) => t.name);
    const allowed = [...(options.allowedToolNames ?? [])];

    expect(names).not.toContain('browse_url');
    expect(allowed).not.toContain('browse_url');
    // 没工具就没有指引 —— 一段描述不存在工具的 prompt 会让模型去调一个它
    // 没有的能力，比不给指引更糟。
    expect(options.systemPrompt).not.toContain('## Reading the web: look with the browser');
  });

  it('rejects a non-URL browse setting instead of registering a dead tool', async () => {
    mocks.resolveCourseSearchCapability.mockReturnValue(null);
    mocks.resolveLearnerProfile.mockReturnValue(null);
    process.env.OPENMAIC_BROWSE_URL = 'localhost:8730';

    const options = await runToBuildAgent();

    expect(options.tools.map((t) => t.name)).not.toContain('browse_url');
    expect(options.systemPrompt).not.toContain('## Reading the web: look with the browser');
  });
});

/**
 * ★ 幽灵工具名判据，量的是**整份装配出来的提示词**（不只是本 fork 自己的块）。
 *
 * 这条补上了 `tool-name-invariant.test.ts` 管不到的那一半：那一条只看我们自己的
 * 五个提示词块与四个工具；而**上游块也会提到工具名** —— 手册 §1.1 记的历史 bug
 * 正是这一类（`browse_url` 的描述一度写着"课程目录用 `course_search`"，
 * 而没配课程库的部署里它根本不存在）。
 *
 * ★ 两种能力配置各量一遍：提示词块是**跟着能力走**的，只量一种等于没量分叉。
 *   这也是"判据要比它声称的宽"那条规矩的直接应用（见结论库）。
 */
describe('★ assembled prompt names no unregistered tool', () => {
  async function phantomToolsWithCourseLibrary(configured: boolean): Promise<string[]> {
    mocks.resolveCourseSearchCapability.mockReturnValue(
      configured ? { baseUrl: 'http://127.0.0.1:8720' } : null,
    );
    const options = await runToBuildAgent();
    const allowed = new Set(options.allowedToolNames ?? []);
    return phantomToolNames(options.systemPrompt, allowed);
  }

  it('with the course library configured', async () => {
    expect(await phantomToolsWithCourseLibrary(true)).toEqual([]);
  });

  it('★ with the course library NOT configured (the §1.1 case)', async () => {
    expect(await phantomToolsWithCourseLibrary(false)).toEqual([]);
  });
});

/**
 * ★ 能力**矩阵**：不是"某个配置下干净"，而是"哪种组合下都干净"。
 *
 * 为什么要有这一组 —— 上一轮的实测教训：`browse_url` 块里那句"工作顺序第 1 步
 * `web_search`"只有"**浏览配了、搜索没配**"才现形，而当时的判据只量了
 * "课程库配/不配"两种配置 ⇒ **它照不到那一处**（是我按配置组合推出来的）。
 *
 * 判据只覆盖一个配置，就会漏掉只在那一个配置里不出现的 bug ——
 * 而"漏掉"这件事本身是静默的：它照样全绿。
 *
 * 三个轴各自独立把关一个提示词块：`web_search` / 课程库 / `browse_url`。
 * 2³ = 8 种组合，每种都过一遍幽灵名判据。
 */
describe('★ assembled prompt: every capability combination', () => {
  const PREV_BROWSE = process.env.OPENMAIC_BROWSE_URL;

  afterEach(() => {
    if (PREV_BROWSE === undefined) delete process.env.OPENMAIC_BROWSE_URL;
    else process.env.OPENMAIC_BROWSE_URL = PREV_BROWSE;
  });

  const COMBOS = [false, true].flatMap((web) =>
    [false, true].flatMap((course) => [false, true].map((browse) => ({ web, course, browse }))),
  );

  it('names no unregistered tool in any of the 8 combinations', async () => {
    const problems: string[] = [];

    for (const combo of COMBOS) {
      mocks.resolveWebSearchCapability.mockReturnValue(
        combo.web ? { providerId: 'searxng', apiKey: '', baseUrl: 'https://search.example' } : null,
      );
      mocks.resolveCourseSearchCapability.mockReturnValue(
        combo.course ? { baseUrl: 'http://127.0.0.1:8720' } : null,
      );
      if (combo.browse) process.env.OPENMAIC_BROWSE_URL = 'http://127.0.0.1:8730';
      else delete process.env.OPENMAIC_BROWSE_URL;

      const options = await runToBuildAgent();
      const allowed = new Set(options.allowedToolNames ?? []);
      const offenders = phantomToolNames(options.systemPrompt, allowed);
      if (offenders.length > 0) {
        problems.push(
          `web=${combo.web} course=${combo.course} browse=${combo.browse} → ${offenders.join(', ')}`,
        );
      }
    }

    expect(problems, `这些组合里点了没注册的工具：\n${problems.join('\n')}`).toEqual([]);
    // 8 种组合真的都跑过了（防止循环写错导致"一个都没量"）。
    expect(COMBOS).toHaveLength(8);
  });
});

/**
 * ★ 门槛开着 ⇒ **解锁路径必须同时注册**，否则是**死锁**。
 *
 * ── 为什么单开这一组 ────────────────────────────────────────────
 *
 * 门槛（`OPENMAIC_PLAN_GATE=1`，**本部署就是开的**）会让 `generate_scene` 拒绝没有
 * 计划条目的页。合法的解锁路径只有一条：用 `plan_freeze { action: "add" }` 写计划。
 *
 * 而 `plan_freeze` 在三处**条件注册**（`runner.ts` 的 1589 构建 / 1703 提示词块 /
 * 1759 放行）。**任何一处坏掉，部署就死锁**：生成被拒、而解锁工具要么不存在、
 * 要么"看得见调不动"、要么 agent 根本不知道有它。
 *
 * 实测（2026-10-07）这个缺口是真的：`OPENMAIC_PLAN_GATE` 在测试里只出现在
 * `generation-tools.test.ts`（直接调 `generate_scene` 验强制行为），
 * **从来没有测试开着门槛跑过 runner 级装配** ⇒ 那三处接线一路未被验证。
 *
 * 判据写成"三处一起断"，因为它们缺一不可 —— 分开写会让人以为通过一处就够了。
 */
describe('★ plan gate ON ⇒ the unlock path must be registered too', () => {
  const PREV = process.env.OPENMAIC_PLAN_GATE;

  afterEach(() => {
    if (PREV === undefined) delete process.env.OPENMAIC_PLAN_GATE;
    else process.env.OPENMAIC_PLAN_GATE = PREV;
  });

  it('registers plan_freeze in tools, allowlist and prompt — all three at once', async () => {
    process.env.OPENMAIC_PLAN_GATE = '1';
    const options = await runToBuildAgent();
    const names = options.tools.map((tool) => tool.name);

    // ① 构建：工具真的在装配里（少这一处 = 根本没有）
    expect(names).toContain('plan_freeze');
    // 不重复注册（同一组被加两次的话，工具表里会出现两个同名项）
    expect(names.filter((name) => name === 'plan_freeze')).toHaveLength(1);
    // ② 放行：注册了不放行 = "看得见、调不动"（§1.1）
    expect([...(options.allowedToolNames ?? [])]).toContain('plan_freeze');
    // ③ 提示词块：不告诉它，它就得自己碰运气（少这一处 = 静默的不可发现）
    expect(options.systemPrompt).toContain('plan_freeze');
  });

  it('registers none of it when the gate is off (the default elsewhere)', async () => {
    delete process.env.OPENMAIC_PLAN_GATE;
    const options = await runToBuildAgent();
    expect(options.tools.map((tool) => tool.name)).not.toContain('plan_freeze');
    expect([...(options.allowedToolNames ?? [])]).not.toContain('plan_freeze');
    // 门槛关着就不该提它 —— 否则是"提一个不存在的能力"（§1.1 的另一半）。
    expect(options.systemPrompt).not.toContain('plan_freeze');
  });
});

/**
 * ★ 提示词块**真的到达模型**。
 *
 * ── 这一组的来历（2026-10-07，本次会话最严重的一个 bug）──────────
 *
 * `courseSystemPrompt()` 原来是**逐个 `if (blocks.X)`** 写的，于是"往
 * `promptBlocks` 里塞一个键"和"真的渲染它"是两件事，而前者**不报错**
 * （`promptBlocks` 是推断类型的变量，传参时不做多余属性检查）。
 *
 * 实测有 **6 个块被静默丢弃**：`assessmentMode`、`planFreeze`、`courseAudit`、
 * `scratch`、`practice`、**`learnerState`**。也就是那几轮写的全部行为指引
 * ——包括"先冻结计划才能生成""修课前先审计""claim 要两个来源""练习结果会回来"
 * 以及**学习状态本身**——**从未到达模型**。块被构造、被传进来、然后被扔掉。
 *
 * 修法是结构性的：渲染改成 `PROMPT_BLOCK_ORDER` 驱动，并配一条**编译期完备性检查**
 * （往接口加字段却忘了加进顺序表 ⇒ 编译不过；已用变异测试验过它会报错）。
 *
 * 这组判据是**行为层**的证明：那些块的正文真的出现在 system prompt 里。
 * 只靠类型不够 —— 类型能保证"被检查"，不能保证"内容对"。
 */
describe('★ prompt blocks actually reach the model', () => {
  it('includes the blocks that used to be dropped silently', async () => {
    const options = await runToBuildAgent();
    const prompt = options.systemPrompt;

    // 每个块用它的标题来认（稳定、且是块自己的第一行）。
    expect(prompt).toContain('## Assessment mode: teaching / homework / exam');
    expect(prompt).toContain('## Repairing a course you already made');
    expect(prompt).toContain('## You have a scratchpad');
    expect(prompt).toContain('## Practice happens in a real folder');
  });

  it('★ and the plan-freeze block only when its gate is on', async () => {
    const PREV = process.env.OPENMAIC_PLAN_GATE;
    try {
      process.env.OPENMAIC_PLAN_GATE = '1';
      expect((await runToBuildAgent()).systemPrompt).toContain('## The course plan is a durable artifact');

      delete process.env.OPENMAIC_PLAN_GATE;
      expect((await runToBuildAgent()).systemPrompt).not.toContain('## The course plan is a durable artifact');
    } finally {
      if (PREV === undefined) delete process.env.OPENMAIC_PLAN_GATE;
      else process.env.OPENMAIC_PLAN_GATE = PREV;
    }
  });
});
