/**
 * `resolveBrowseCapability` 的 env 解析规则 + 工作台版 `browse_url` 的形状。
 *
 * 单独一个文件，**不 mock 任何东西** —— 测的就是真实实现。
 *
 * 这些规则的意义跟课程库那份一样：返回 null 就是"不注册工具"。一个假的真值
 * 会让模型拿到一个一调就死的工具；一个假的 null 会让浏览器能力永远用不上。
 * 两种都是静默失败。
 *
 * ★ 这里还钉住一条**能力注册原则的反面**：工作台版必须整体替换掉
 *   `lib/chat/pi` 那份描述，因为那份结尾会说"课程目录用 course_search、
 *   本地文档用 read_document" —— 在没配课程库的部署里，那是在指名一个
 *   不存在的工具。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  browsePromptBlock,
  buildAgentBrowseUrlTool,
  resolveBrowseCapability,
} from '@/lib/server/agent-runtime/browse-url';

const PREV = process.env.OPENMAIC_BROWSE_URL;

afterEach(() => {
  if (PREV === undefined) delete process.env.OPENMAIC_BROWSE_URL;
  else process.env.OPENMAIC_BROWSE_URL = PREV;
});

describe('resolveBrowseCapability', () => {
  it('returns the base URL when configured', () => {
    process.env.OPENMAIC_BROWSE_URL = 'http://127.0.0.1:8730';
    expect(resolveBrowseCapability()).toEqual({ baseUrl: 'http://127.0.0.1:8730' });
  });

  it('trims surrounding whitespace', () => {
    process.env.OPENMAIC_BROWSE_URL = '  http://127.0.0.1:8730  ';
    expect(resolveBrowseCapability()).toEqual({ baseUrl: 'http://127.0.0.1:8730' });
  });

  it('is null when unset or blank', () => {
    delete process.env.OPENMAIC_BROWSE_URL;
    expect(resolveBrowseCapability()).toBeNull();

    process.env.OPENMAIC_BROWSE_URL = '   ';
    expect(resolveBrowseCapability()).toBeNull();
  });

  it('rejects a value that is not an http(s) URL', () => {
    process.env.OPENMAIC_BROWSE_URL = 'localhost:8730';
    expect(resolveBrowseCapability()).toBeNull();
  });

  it('accepts https', () => {
    process.env.OPENMAIC_BROWSE_URL = 'https://browser.example';
    expect(resolveBrowseCapability()).toEqual({ baseUrl: 'https://browser.example' });
  });
});

describe('buildAgentBrowseUrlTool', () => {
  const tool = buildAgentBrowseUrlTool({ baseUrl: 'http://127.0.0.1:8730' });

  it('keeps the tool name and sequential execution', () => {
    expect(tool.name).toBe('browse_url');
    expect(tool.executionMode).toBe('sequential');
  });

  it('describes the browser as the answer to JS pages and 403s, not as a replacement', () => {
    expect(tool.description).toContain('JavaScript-rendered');
    expect(tool.description).toContain('403');
    // 「看」和「存」的分工：browse 负责看，fetch_url 负责留下。
    expect(tool.description).toContain('fetch_url');
    expect(tool.description).toContain('read_material');
  });

  it('never names a tool this deployment may not have registered', () => {
    // 能力和工具同生共死：没配 OPENMAIC_COURSE_SEARCH_URL 就没有
    // course_search，描述里也就不能出现它。
    expect(tool.description).not.toContain('course_search');
    expect(tool.description).not.toContain('read_document');
  });
});

describe('browsePromptBlock', () => {
  const block = browsePromptBlock({ hasWebSearch: true });

  it('lays out look-then-keep so the model does not browse and forget to store', () => {
    expect(block).toContain('## Reading the web: look with the browser');
    expect(block).toContain('browse_url');
    expect(block).toContain('fetch_url');
    expect(block).toContain('read_material');
    expect(block).toContain('web_search');
  });

  it('states the SSRF boundary instead of leaving a refusal unexplained', () => {
    expect(block).toMatch(/private and internal network addresses/);
  });
});

/**
 * ★ 能力条件：只点名真的注册了的能力（§1.1）。
 *
 * 实测来历（2026-10-07）：整份装配提示词的幽灵名判据抓到 `web_search` 被点名，
 * 而那个配置里**没有** web search。本块由 browse_url 单独把关 —— 两个能力是分开的。
 */
describe('browsePromptBlock 的能力条件', () => {
  it('includes the search step when web search is registered', () => {
    const block = browsePromptBlock({ hasWebSearch: true });
    expect(block).toContain('web_search');
    expect(block).toContain('1. `web_search`');
  });

  it('★ drops the search step (and renumbers) when it is not', () => {
    const block = browsePromptBlock({ hasWebSearch: false });
    expect(block).not.toContain('web_search');
    // 剩下的两步要重新编号，否则"第 1 步"没了、却从第 2 步开始。
    expect(block).toContain('1. `browse_url`');
    expect(block).toContain('2. `fetch_url`');
    expect(block).not.toContain('3. `fetch_url`');
  });
});
