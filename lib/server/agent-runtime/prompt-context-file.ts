/**
 * 把一份 Markdown 上下文文件读成可注入提示词的文本。
 *
 * ── 为什么抽出来 ──────────────────────────────────────────────────
 *
 * 现在有不止一处需要"读一个文件、注入系统提示词"：学习者画像、指定材料清单，
 * 以后大概还会有别的（目标岗位 JD、题库……）。它们的**读取规则完全一样**：
 *
 *   · 路径来自 env（没配 = 不注入）
 *   · 任何失败都静默返回 null（不注入，而不是注入坏内容）
 *   · 剥掉 HTML 注释（那是写给编辑者的，不是给模型的）
 *   · 设大小上限（路径指错文件时宁可不要，也不能把上下文撑爆）
 *   · **每次调用都重读**（改文件不用重启）
 *
 * 复制这套规则到每个新用途上，早晚会有一处漏掉大小上限或者忘记剥注释。
 * 所以读的规则只写一遍，各处只负责各自的**框定语**。
 *
 * ── 生命周期（容易搞混）───────────────────────────────────────────
 *
 *   · **路径**在调用方模块加载时求值（`agentRuntimeConfig`）—— 换路径要重启；
 *   · **内容**每次调用都重读 —— 改文件本身不用重启。
 *
 * 后者才是常用的那个：这些文件天天改，路径基本不动。
 */
import { readFileSync, statSync } from 'node:fs';

/** 原始文件大小上限。超了就当没配 —— 宁可不要，也不能把上下文撑爆。 */
const MAX_BYTES = 64 * 1024;

/** 注入后的字符上限，防止一份超长文件挤掉技能清单和工具指引。 */
const MAX_CHARS = 24_000;

/** HTML 注释是写给**编辑者**的，不注入。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * 读一个上下文文件；任何失败都返回 null。
 *
 * 静默失败是刻意的：一个指错的路径不该让每次会话都报错，只该让它像
 * 没配一样消失 —— 跟 course_search / web_search 的能力注册同一个原则。
 */
export function readPromptContextFile(path: string | undefined): string | null {
  if (!path) return null;

  try {
    if (statSync(path).size > MAX_BYTES) return null;
    const body = readFileSync(path, 'utf8').replace(HTML_COMMENT, '').trim();
    if (!body) return null;
    return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n…（已截断）` : body;
  } catch {
    return null;
  }
}
