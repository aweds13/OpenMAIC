import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { askForHint, type XqHintDeps } from '../../lib/learning/xq-hint';

const TARGET = {
  stageId: 'stage-A',
  sceneId: 'scene-p1',
  questionId: 'q3',
  stem: '关于 final 变量，下面哪种说法是对的？',
};

function deps(overrides: Partial<XqHintDeps> = {}): XqHintDeps {
  return {
    template: '方向：{{stem}}',
    send: vi.fn(async () => {}),
    record: vi.fn(async () => ({ ok: true })),
    now: () => new Date('2026-11-10T02:00:00.000Z'),
    logFailure: vi.fn(),
    ...overrides,
  };
}

describe('askForHint', () => {
  it('记事件在前、发消息在后，且消息里带题干', async () => {
    const order: string[] = [];
    const d = deps({
      record: vi.fn(async () => {
        order.push('record');
        return { ok: true };
      }),
      send: vi.fn(async () => {
        order.push('send');
      }),
    });

    const result = await askForHint(TARGET, 'instrumental', d);

    expect(result).toEqual({ status: 'sent', code: '' });
    expect(order).toEqual(['record', 'send']);
    expect(d.send).toHaveBeenCalledWith(`方向：${TARGET.stem}`);
  });

  it('★ 记事件时就带上分型与题干 —— 分型不是事后猜的', async () => {
    const record = vi.fn(async () => ({ ok: true }));
    await askForHint(TARGET, 'executive', deps({ record }));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'hint_requested',
        stageId: 'stage-A',
        sceneId: 'scene-p1',
        questionId: 'q3',
        hintSubtype: 'executive',
        occurredAt: '2026-11-10T02:00:00.000Z',
        payload: { stem: TARGET.stem, subtype: 'executive' },
      }),
    );
  });

  it('★ 闸挡住时消息根本不该发出去', async () => {
    const send = vi.fn(async () => {});
    const result = await askForHint(
      TARGET,
      'instrumental',
      deps({ record: vi.fn(async () => ({ ok: false, code: 'ANSWER_FIRST' })), send }),
    );

    expect(result).toEqual({ status: 'refused', code: 'ANSWER_FIRST' });
    expect(send).not.toHaveBeenCalled();
  });

  it('★ 记事件失败（不是闸）与闸挡住要分开 —— 界面说的话不同', async () => {
    const send = vi.fn(async () => {});
    const result = await askForHint(
      TARGET,
      'executive',
      deps({ record: vi.fn(async () => ({ ok: false })), send }),
    );

    expect(result).toEqual({ status: 'failed', code: '' });
    expect(send).not.toHaveBeenCalled();
  });

  it('记事件抛错时也按失败处理，不冒泡', async () => {
    const logFailure = vi.fn();
    const send = vi.fn(async () => {});
    const result = await askForHint(
      TARGET,
      'instrumental',
      deps({
        record: vi.fn(async () => {
          throw new Error('offline');
        }),
        send,
        logFailure,
      }),
    );

    expect(result.status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(logFailure).toHaveBeenCalled();
  });

  it('★ 事件记上了但消息发不出去时报 unsent —— 别把它说成「没问成」', async () => {
    const logFailure = vi.fn();
    const result = await askForHint(
      TARGET,
      'instrumental',
      deps({
        send: vi.fn(async () => {
          throw new Error('model not configured');
        }),
        logFailure,
      }),
    );

    expect(result).toEqual({ status: 'unsent', code: '' });
    expect(logFailure).toHaveBeenCalled();
  });
});

describe('两侧字面量不许漂', () => {
  /**
   * 客户端为了不把 `@openmaic/storage` 拖进浏览器 bundle，自己写了一份
   * `'ANSWER_FIRST'`。两边漂了以后症状是安静的：闸照样挡，界面却把
   * 「先写下你的想法」说成「发送失败」。
   */
  it('★ 客户端的 ANSWER_FIRST 与服务端同名常量一致', () => {
    const gate = readFileSync(join(process.cwd(), 'lib/persistence/xq-hint-gate.ts'), 'utf8');
    expect(gate).toContain("export const ANSWER_FIRST_CODE = 'ANSWER_FIRST';");

    const hint = readFileSync(join(process.cwd(), 'lib/learning/xq-hint.ts'), 'utf8');
    expect(hint).toContain("const ANSWER_FIRST_CODE = 'ANSWER_FIRST';");
  });
});
