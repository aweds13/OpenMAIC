import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 自评是**事实**，不是**判定**。
 *
 * 这条判据读源码而不是跑函数：`lib/quiz/xq-mastery.ts` 里只要出现
 * `confidence`，就说明有人把自评接进了掌握度计算。它不会以「代码报错」
 * 的形式失败 —— 掌握度会照常算出来，只是算错了，而且从输出上完全看不出来。
 *
 * 依据（M 文档 §3.1 X2）：Karpicke & Roediger 2008 四组被试预测自己一周后
 * 约 **50%**（20.8/20.4/22.0/20.3），实际 80% 对 33%，组间 F<1 ——
 * 自评与真实保持**零相关**。零相关的量拿来加权等于加噪声。
 */
const ROOT = process.cwd();

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('自评不许进判定', () => {
  it('★ 掌握度计算里没有、也不许有自评值', () => {
    const source = readSource('lib/quiz/xq-mastery.ts');
    // ★ 这里**不能**笼统地禁 `confidence`：本文件有一个同名的统计常量
    // `CONFIDENCE = 0.8`，那是 Beta 可信区间的置信水平，与自评毫无关系。
    // 禁具体的那几个名字，才既挡得住误接、又不误伤统计量。
    for (const forbidden of [
      'confidence_pre',
      'confidencePre',
      'ConfidenceMap',
      'ConfidenceLevel',
    ]) {
      expect(source, `${forbidden} 不该出现在掌握度计算里`).not.toContain(forbidden);
    }
  });

  it('★ 证据条的契约里只有 countedN / correct / guessRate / askedAt 这几件事', () => {
    const source = readSource('lib/quiz/xq-mastery.ts');
    const start = source.indexOf('export interface EvidenceItem');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n}', start));
    expect(block).toContain('countedN');
    expect(block).toContain('correct');
    expect(block).not.toMatch(/confidence/i);
  });

  it('★ 自评只落 xq_probe_item.confidence_pre —— 探针写入器是它唯一的写入方', () => {
    const recorder = readSource('lib/persistence/xq-probe-recorder.ts');
    expect(recorder).toContain('confidencePre');
    const store = readSource('lib/persistence/xq-learner-store.ts');
    // 这一列在 ingest 的列清单里，且只在 ingest 里
    expect(store.match(/confidence_pre/g)?.length ?? 0).toBeGreaterThan(0);
    // 但 recompute 的输入不带它
    expect(store).not.toMatch(/confidencePre[\s\S]{0,200}correctnessWeight/);
  });
});
