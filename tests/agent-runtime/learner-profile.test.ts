/**
 * 学习者画像的读取与注入。
 *
 * ★ 测试必须先设 env 再**动态导入**：画像**路径**来自 agentRuntimeConfig，
 *   而那是模块加载时求值的（跟该文件里其它配置一样）。先 import 再改 env
 *   是测不出东西的 —— 这一点我第一次就写错了，测试把我抓出来了。
 *   （**内容**是每次调用重读的，那个用普通断言就能测。）
 *
 * 两个必须钉住的行为：
 *   1. 读不到就**不注入** —— 路径错、文件空、文件过大，任何一种都该像
 *      "没配"一样消失。一个指错的 env 不该让每次会话都带着一段空的画像。
 *   2. HTML 注释不注入 —— 那是写给编辑者的（"这一层只放状态"），不是给
 *      模型的。注入进去白占上下文，还可能被模型当成指令。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

type ProfileModule = typeof import('@/lib/server/agent-runtime/learner-profile');

const PREV = process.env.OPENMAIC_LEARNER_PROFILE_PATH;

afterEach(() => {
  if (PREV === undefined) delete process.env.OPENMAIC_LEARNER_PROFILE_PATH;
  else process.env.OPENMAIC_LEARNER_PROFILE_PATH = PREV;
  vi.resetModules();
});

/** 设好 env 再加载模块，让 agentRuntimeConfig 看到这个值。 */
async function loadWith(path: string | undefined): Promise<ProfileModule> {
  if (path === undefined) delete process.env.OPENMAIC_LEARNER_PROFILE_PATH;
  else process.env.OPENMAIC_LEARNER_PROFILE_PATH = path;
  vi.resetModules();
  return import('@/lib/server/agent-runtime/learner-profile');
}

function tempProfile(content: string, name = 'profile.md'): string {
  const dir = mkdtempSync(join(tmpdir(), 'learner-profile-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('resolveLearnerProfile', () => {
  it('is null when the path is unset', async () => {
    const mod = await loadWith(undefined);
    expect(mod.resolveLearnerProfile()).toBeNull();
  });

  it('is null when the file does not exist', async () => {
    const mod = await loadWith(tempProfile('x', 'missing.md') + '.nope');
    expect(mod.resolveLearnerProfile()).toBeNull();
  });

  it('is null for a file with nothing but comments and whitespace', async () => {
    const mod = await loadWith(tempProfile('<!-- 只放状态 -->\n\n   \n'));
    expect(mod.resolveLearnerProfile()).toBeNull();
  });

  it('strips HTML comments and keeps the body', async () => {
    const mod = await loadWith(tempProfile('<!-- 写给编辑者的说明 -->\n## 目标\n\n- 成为专家\n'));
    const profile = mod.resolveLearnerProfile();
    expect(profile).toContain('## 目标');
    expect(profile).toContain('成为专家');
    expect(profile).not.toContain('写给编辑者');
  });

  it('re-reads the content on every call (editing the file needs no restart)', async () => {
    const path = tempProfile('## 目标\n\n- 第一版\n');
    const mod = await loadWith(path);
    expect(mod.resolveLearnerProfile()).toContain('第一版');

    writeFileSync(path, '## 目标\n\n- 第二版\n', 'utf8');
    // 没有重载模块 —— 内容必须跟着文件变。
    expect(mod.resolveLearnerProfile()).toContain('第二版');
  });
});

describe('learnerProfilePromptBlock', () => {
  it('frames UNKNOWN as an instruction to ask, and forbids reciting the profile', async () => {
    const mod = await loadWith(undefined);
    const block = mod.learnerProfilePromptBlock('## 知识状态\n\n| Java | UNKNOWN |');

    expect(block).toContain('## Learner profile');
    // UNKNOWN 的语义是这个档案的核心用法：去问，不要猜。
    expect(block).toContain('`UNKNOWN` means ask, do not assume');
    expect(block).toContain('ask_user');
    // 不要把档案念回给学习者，也不要提自己有档案。
    expect(block).toContain('Do not recite this profile');
    // 档案本体必须在里面。
    expect(block).toContain('| Java | UNKNOWN |');
  });
});
