import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 接线判据：`/xq/concepts` 那条路由真的接上了。
 *
 * 仓里没有 `@testing-library/react`，`tests/**\/*.test.ts` 是唯一入口且跑 node；
 * 而路由的行为测试已经在 `tests/persistence/xq-concepts-route.test.ts` 里覆盖。
 * 这一份只钉住「它没有被写成一个零调用方的模块」这件事 ——
 * `lib/notes/local-kb.ts` 就是那样挂着的，规格里专门为它写了一整段。
 */
const ROUTE = readFileSync('app/api/persistence/[...path]/route.ts', 'utf8');
const MODULE = readFileSync('lib/persistence/xq-concept-graph.ts', 'utf8');

describe('/xq/concepts 接线', () => {
  it('★ 路由真的 import 了概念图模块，而不是只写了路径常量', () => {
    expect(ROUTE).toContain("from '@/lib/persistence/xq-concept-graph'");
    expect(ROUTE).toContain('readConceptGraph');
    expect(ROUTE).toContain('XQ_CONCEPTS_PATH');
  });

  it('★ 派发分支在，且只接受 GET', () => {
    expect(ROUTE).toContain('path === XQ_CONCEPTS_PATH');
    expect(ROUTE).toContain('xq/concepts accepts GET only');
  });

  it('★ 只读 —— 模块里没有一条写 SQL', () => {
    for (const forbidden of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'CREATE TABLE']) {
      expect(MODULE, `${forbidden} 不该出现在只读模块里`).not.toContain(forbidden);
    }
  });

  it('★ 不产出顺序 —— 模块里没有 sort/order-by 建议', () => {
    // 「按图谱排序」是产品决策，规格写死它不许上线；这个模块只回答图上可算的问题。
    expect(MODULE).not.toContain('recommendOrder');
    expect(MODULE).not.toContain('studyOrder');
    expect(MODULE).not.toContain('nextConcept');
  });
});
