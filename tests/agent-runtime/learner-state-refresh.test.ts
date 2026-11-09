/**
 * 状态块的**刷新时机**判据。
 *
 * 那份文件是「机器写的投影」，而投影只有在有人来写的时候才变。此前唯一的
 * 调用点是 agent 运行开头（`runner.ts`），于是「答完题就关掉」的人，文件会
 * 一直停在旧内容上 —— 实测磁盘 946 字节，而同一时刻用同一个库渲染出来是
 * 1405 字节，差的是一整节「练习」。
 *
 * 这里钉两件事：
 * 1. 用调用方连接刷新的那个函数**绝不抛**（它是派生物，失败只该少刷一次）；
 * 2. 路由真的在「库变了」之后叫它，而且叫的是**同一个池**，不是新建一个。
 *
 * ★ 为什么不渲染页面去验：仓里没有 `@testing-library/react`，
 *   `tests/**\/*.test.ts` 是唯一入口、跑在 node 环境。所以接线类判据读源码
 *   —— 与 `tests/learning/quiz-ask-wiring.test.ts` 同一套理由。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { refreshLearnerStateWithConnection } from '@/lib/server/agent-runtime/learner-state';

const ROUTE = 'app/api/persistence/[...path]/route.ts';

describe('refreshLearnerStateWithConnection', () => {
  it('★ 库连不上也不抛 —— 它只是少刷一次文件', async () => {
    const broken = {
      query: () => {
        throw new Error('connection refused');
      },
    } as never;
    await expect(refreshLearnerStateWithConnection(broken)).resolves.toBeUndefined();
  });

  it('★ 没配状态文件路径时安静地什么都不做', async () => {
    // 测试环境不设 OPENMAIC_LEARNER_PROFILE_PATH / _STATE_PATH，所以
    // `learnerStatePath()` 是 undefined ⇒ 在碰库之前就返回了。
    let touched = false;
    const spy = {
      query: () => {
        touched = true;
        return { rows: [] };
      },
    } as never;
    await expect(refreshLearnerStateWithConnection(spy)).resolves.toBeUndefined();
    expect(touched).toBe(false);
  });
});

describe('路由把「库变了」接到刷新上', () => {
  it('★ appendRecord 那条路用 onRecorded 通知，且不自己建池', async () => {
    const source = await readFile(ROUTE, 'utf8');
    const decorator = source.slice(
      source.indexOf('withXqProbeRecording(guardedServerRuntimeStore'),
      source.indexOf('withXqProbeRecording(guardedServerRuntimeStore') + 700,
    );
    expect(decorator).toContain('onRecorded');
    expect(decorator).toContain('refreshLearnerStateWithConnection(pool');
  });

  it('★ 复习关掉一关之后也刷 —— 到期清单变了', async () => {
    const source = await readFile(ROUTE, 'utf8');
    const at = source.indexOf('if (result.recorded) {');
    expect(at).toBeGreaterThan(-1);
    const window = source.slice(at, at + 200);
    expect(window).toContain('refreshLearnerStateWithConnection(queryable)');
  });

  it('★ 两处都不 await 结果 —— 写成功了，刷不动不该让人以为写失败', async () => {
    const source = await readFile(ROUTE, 'utf8');
    // `void` 前缀是刻意的：把 Promise 丢掉，失败在函数内部自己兜。
    expect(source).toContain('void refreshLearnerStateWithConnection(pool');
    expect(source).toContain('void refreshLearnerStateWithConnection(queryable)');
  });
});
