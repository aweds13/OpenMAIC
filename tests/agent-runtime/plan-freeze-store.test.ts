import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyPlanFreeze, freezePlan } from '@/lib/server/agent-runtime/plan-freeze';
import {
  planFreezeFile,
  readPlanFreeze,
  writePlanFreeze,
} from '@/lib/server/agent-runtime/plan-freeze-store';

const T0 = 1_700_000_000_000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plan-freeze-'));
  process.env.OPENMAIC_PLAN_FREEZE_DIR = dir;
});

afterEach(async () => {
  delete process.env.OPENMAIC_PLAN_FREEZE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('plan-freeze 文件层', () => {
  it('says "not frozen" for a stage that has no file (never throws)', async () => {
    const state = await readPlanFreeze('stage-unknown');
    expect(state.frozen).toBe(false);
    expect(state.revision).toBe(0);
  });

  it('round-trips a frozen state', async () => {
    const frozen = freezePlan(emptyPlanFreeze('stage-a'), { at: T0, entryCount: 4 }).state;
    expect(await writePlanFreeze(frozen)).toBe(true);

    const back = await readPlanFreeze('stage-a');
    expect(back.frozen).toBe(true);
    expect(back.frozenAt).toBe(T0);
    expect(back.frozenEntryCount).toBe(4);
  });

  it('★ keeps two stages apart — stageId is the key, not a shared file', async () => {
    await writePlanFreeze(freezePlan(emptyPlanFreeze('stage-a'), { at: T0, entryCount: 2 }).state);
    expect((await readPlanFreeze('stage-a')).frozen).toBe(true);
    expect((await readPlanFreeze('stage-b')).frozen).toBe(false);
  });

  it('repairs a corrupt file instead of throwing (a broken file must not wedge generation)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(planFreezeFile('stage-broken'), '{ this is not json', 'utf8');
    const state = await readPlanFreeze('stage-broken');
    expect(state.frozen).toBe(false);
  });

  it('★ sanitises the stageId before using it as a filename', async () => {
    // 一个奇怪的 id 不能把路径带出去。
    const path = planFreezeFile('../../etc/passwd');
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('..');
  });

  it('writes into the configured directory', async () => {
    await writePlanFreeze(emptyPlanFreeze('stage-a'));
    expect(planFreezeFile('stage-a').startsWith(dir)).toBe(true);
  });
});
