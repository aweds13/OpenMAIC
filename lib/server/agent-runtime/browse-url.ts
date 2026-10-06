/**
 * `browse_url` 进入**工作台（agent-runtime）**这条路。
 *
 * ── 为什么需要它（实测，不是推测）─────────────────────────────────
 *
 * 在此之前工作台只有 `fetch_url`：一次 HTTP 请求、拿原始 HTML。实测
 * （2026-10-05，75 次 fetch_url）它的失败分布是：
 *
 *   · 7 次 HTTP 404
 *   · 3 次被 anti-bot 关键词拦掉（其中 2 次是被裸词 `captcha` 误伤 ——
 *     正常页面的 JS bundle 里出现这个词）
 *   · 2 次重定向超过 5 跳
 *   · 2 次 fetch failed
 *   · 1 次 HTTP 403
 *   · 4 次被 session URL 信任门拒（`url_not_in_session`）
 *   · 只有 56 次真的拿到了正文，平均 17,443 字符
 *
 * 而 `browse_url` 走的是**真浏览器（Playwright + 系统 Edge）**：页面渲染
 * 完、等网络空闲、去掉 script/style/nav/footer 再取 innerText。它天然
 * 解决其中两类 —— JS 渲染页（fetch_url 拿到的是空壳）和一部分 403
 * （真浏览器的请求头/指纹过得了，裸 HTTP 过不了）。
 *
 * 服务本身（`_tools/course-crawler/browse_server.py`，8730）已经在
 * `start_all.ps1` 里常驻，`.env.local` 也早就配了 `OPENMAIC_BROWSE_URL` ——
 * 只是**没有接进工作台**，这个工具此前只挂在 `lib/chat/pi/tools/call-agent.ts`
 * 那条链上。
 *
 * ── 能力注册，不是开关 ────────────────────────────────────────────
 *
 * 跟 web-search.ts / course-search.ts 同一个原则：**没配这个服务就不注册
 * 这个工具**，也**不会**在提示词里提它。不给模型一个"存在于工具表里但一调
 * 就失败"的死工具 —— 那是模型唯一没法正确理解的一种"不可用"。
 *
 * ── 和 fetch_url 的分工（这是提示词必须说清的部分）────────────────
 *
 * 两者不是替代关系，是**顺序关系**：
 *
 *   1. `web_search`     —— 找有哪些页面（返回 URL，进 session 信任门）
 *   2. `browse_url`     —— 打开页面**看内容**（渲染后取正文，可以带 maxChars）
 *   3. `fetch_url`      —— 把**值得留下的**页面整篇抓成本会话的 web material
 *   4. `read_material`  —— 分段精读那份 material（8000 字符/页）
 *
 * 如果只说"优先用浏览器"，模型会用浏览器读一遍、然后就没有然后了 ——
 * 内容没有落成 material，也就没法精读、没法在后面的页面生成里引用。
 * 所以提示词必须把"看"和"存"分开讲。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';

import { buildBrowseUrlTool, type BrowseConfig } from '@/lib/chat/pi/tools/browse-url';

/** 这个部署的浏览器能力；没配就是 null。 */
export function resolveBrowseCapability(): BrowseConfig | null {
  const baseUrl = process.env.OPENMAIC_BROWSE_URL?.trim();
  if (!baseUrl) return null;
  // 只做最低限度的形状校验：给了值就信任它是 URL，连通性由调用时暴露。
  // 这里**不主动探活** —— 启动期探活会让一个暂时没起来的 sidecar 永久摘掉工具。
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  return { baseUrl };
}

/**
 * 给 agent-runtime 用的 `browse_url`。
 *
 * 描述被**整体替换**（不是追加）。`lib/chat/pi` 那份的结尾是
 * "它不是用来查课程目录的：课程记录来自 course_search……本地文档用
 * read_document 读" —— 那句话在 `course_search` 没配的部署里**指名了不存在
 * 的工具**（同一个能力注册原则的反面）。所以这里写一份只依赖本部署确实
 * 注册了什么的描述：browse_url 由 `OPENMAIC_BROWSE_URL` 门控，
 * `fetch_url` 无条件存在，所以只提 fetch_url。
 */
export function buildAgentBrowseUrlTool(capability: BrowseConfig): AgentTool<never, never> {
  const base = buildBrowseUrlTool({ config: capability });

  const tool = {
    ...base,
    label: 'Open a web page in a real browser',
    description:
      'Open an http(s) page in a real browser (Playwright + Edge), let it render, and return the ' +
      'readable text plus the links on it. Use it for pages that plain `fetch_url` cannot handle:\n' +
      '  · JavaScript-rendered pages — a bare HTTP fetch sees an empty shell;\n' +
      '  · pages that need redirects followed or the network to go idle;\n' +
      '  · pages that answer 403 to a plain HTTP client but load fine in a browser;\n' +
      '  · when you want the article text rather than the whole HTML.\n' +
      'Prefer `fetch_url` when you want the page KEPT for this session (it stores a web material ' +
      'you can page through with `read_material`); use `browse_url` to look, and `fetch_url` to ' +
      'keep. Private/internal addresses are refused by the server, on every redirect.',
    parameters: base.parameters,
    executionMode: 'sequential',
  } as unknown as AgentTool<never, never>;

  return tool;
}

/**
 * 提示词块，**与工具同生共死**：只有浏览器被注册时才出现，所以模型不会读到
 * 一段描述不存在工具的指引。
 *
 * ★ 这里刻意把「看」和「存」拆开讲：只说"优先用真浏览器"会诱导模型用
 *   browse_url 读一遍就完事 —— 内容没落成 material，后面的页面生成引用不到，
 *   等于白读。顺序写清楚，模型才会接着调 fetch_url。
 */
export function browsePromptBlock(): string {
  return [
    '## Reading the web: look with the browser, keep with fetch_url',
    '',
    'You have two ways to open a page, and they are **not alternatives**:',
    '',
    '- **`browse_url`** — a real browser (Playwright + Edge). Renders JavaScript, follows',
    '  redirects, waits for the network to settle, and returns the readable text plus the page\'s',
    '  links. Use it when a plain HTTP fetch comes back empty, 403s, or obviously did not render —',
    '  many course pages, modern docs sites and community pages need it.',
    '- **`fetch_url`** — one HTTP request, extracted to Markdown and **stored as a web material**',
    '  for this session. This is the one that *keeps* the page: it returns a material id, and you',
    '  page through the full text with `read_material`.',
    '',
    'So the working order is:',
    '',
    '1. `web_search` — find which pages exist (a returned URL enters this session\'s trust gate).',
    '2. `browse_url` — open a candidate and see what is actually on it.',
    '3. `fetch_url` — once a page is worth keeping, store it; then `read_material` through the',
    '   stored copy at 8000 characters a page, following `nextOffset` until it stops coming back.',
    '',
    'Reading a page you browsed but never fetched means you cannot quote it, page through it, or',
    're-read it after the context is compacted. If the content matters, fetch it.',
    '',
    'Both tools refuse private and internal network addresses, including cloud metadata',
    'endpoints, on the original URL and on every redirect. A refusal is a real answer: report it',
    'and look for another source instead of presenting the page as if it had been read.',
  ].join('\n');
}
