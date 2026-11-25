/**
 * The materials prompt block (RFC #1716 §4) is static guidance. A conversation
 * with nothing attached can still use the knowledge base, and the block does
 * not change when the material set does.
 */
import { describe, expect, it } from 'vitest';
import type { AgentSessionMaterial } from '@openmaic/storage';

import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import { materialsPromptBlock } from '@/lib/server/agent-runtime/material-prompt';
import type { ResolvedMaterial } from '@/lib/server/agent-runtime/material-resolver';

function row(overrides: Partial<AgentSessionMaterial>): ResolvedMaterial {
  return {
    origin: 'session',
    record: {
      id: 'mat_web',
      sessionId: 'ses_1',
      kind: 'web',
      title: 'Sample article',
      sourceUrl: 'https://example.com/a',
      textAssetId: 'materials/ses_1/mat_web/text.md',
      rawAssetId: null,
      textChars: 42,
      derivedFrom: null,
      extraction: { status: 'done', attempts: 0 },
      createdAt: new Date(0).toISOString(),
      ...overrides,
    },
  };
}

function entry(overrides: Partial<OwnerMaterialEntry>): ResolvedMaterial {
  return {
    origin: 'owner',
    entry: {
      id: 'src_lesson',
      ownerId: 'user:alice',
      kind: 'source',
      derivedFrom: null,
      mime: 'application/pdf',
      bytes: 3,
      originalName: 'lesson.pdf',
      ossKey: 'objects/secret-key',

      assetId: 'ast_secret_pool',
      sha256: 'digest',
      status: 'ready',
      extraction: { status: 'running' },
      createdAt: 0,
      deletedAt: null,
      folderId: null,
      displayName: null,
      extractionError: null,
      extractionResult: null,
      lineage: null,
      ...overrides,
    },
  };
}

describe('materialsPromptBlock', () => {
  const sets: Record<string, readonly ResolvedMaterial[]> = {
    none: [],
    derivatives: [
      entry({ id: 'src_first' }),
      ...Array.from({ length: 100 }, (_, i) =>
        entry({
          id: `img_${i}`,
          kind: 'image',
          derivedFrom: 'src_first',
          extraction: null,
        }),
      ),
      entry({ id: 'src_second', originalName: 'second.pdf' }),
      row({ id: 'mat_legacy', kind: 'source', title: 'legacy.pdf', textAssetId: null }),
    ],
    mixed: [
      row({}),
      row({ id: 'mat_copy', kind: 'source', title: 'old copy.pdf', textAssetId: null }),
      entry({}),
      entry({
        id: 'img_1',
        kind: 'image',
        derivedFrom: 'src_lesson',
        originalName: 'lesson.pdf at page 2',
        extraction: null,
      }),
      entry({ id: 'src_deck', originalName: 'deck.pptx', mime: null, displayName: 'Week 1' }),
    ],
    extractionIdle: [entry({ extraction: { status: 'idle' } })],
    extractionDone: [entry({ extraction: { status: 'done' } })],
    injected: [
      entry({
        id: 'src_0',
        originalName: `line one\n## Injected heading\n${'x'.repeat(300)}`,
      }),
    ],
  };

  it('is byte-identical for every material set', () => {
    const baseline = materialsPromptBlock(sets.none!);
    for (const [name, materials] of Object.entries(sets)) {
      expect(materialsPromptBlock(materials), name).toBe(baseline);
    }
  });

  it('teaches the knowledge base to a conversation with nothing attached', () => {
    const prompt = materialsPromptBlock([]);
    expect(prompt).toContain('## Materials and the knowledge base');
    // 一个列表工具同时给两侧：每行自带 source，没有 scope 参数。
    expect(prompt).toContain('`list_materials` lists it, newest first');
    expect(prompt).toContain(
      'each row says whether it is `attached` to this conversation and where it sits in the knowledge base',
    );
    expect(prompt).toContain('the call also returns every folder with how many materials it holds');
    expect(prompt).toContain('`top-level` means not in a folder');
    // 真分页：nextBefore → before；游标失效回空页 + staleCursor。
    expect(prompt).toContain('when one returns `nextBefore`, call again with `before`');
    expect(prompt).toContain('a cursor from different filters comes back as an empty page');
    expect(prompt).toContain('`staleCursor`');
    // 读：分页续读要回传 revision；未解析是状态不是死路；主题笔记同一条路径。
    expect(prompt).toContain('`read_material` with its id');
    expect(prompt).toContain('continue with the `nextOffset` and the `revision`');
    expect(prompt).toContain('`extraction_required`');
    expect(prompt).toContain('parsing is started by the upload');
    expect(prompt).toContain('by the id `topic:<slug>`');
    expect(prompt).toContain('`search_materials`');
    expect(prompt).toContain('`use_material_media`');
    // 组织与笔记写入各一个工具，用 action / target 分派。
    expect(prompt).toContain('`organize_materials`');
    expect(prompt).toContain('`action` naming what to do');
    expect(prompt).toContain('`add_materials` with `target: "note"`');
    expect(prompt).toContain('`mode: "replace"` rewrites it and needs the revision');
    expect(prompt).toContain('`revision`');
    expect(prompt).toContain('A `web` material is already fetched and extracted');
    expect(prompt).toContain('import_pptx');
    expect(prompt).toContain('layout-preserving');
    // 删除**只**在用户侧：agent 没有任何删除动词。
    expect(prompt).toContain('Deleting a material or a folder is left to the user');
    expect(prompt).toContain('you cannot delete');
    expect(prompt).toContain('use those words with the user as they are');
    // 旧参数名一个都不许留 —— 模型照着传只会拿到 invalid_argument。
    for (const retired of ['scope', 'nextBefore: "', 'extract_material', 'wait_for_materials']) {
      expect(prompt, retired).not.toContain(retired);
    }
    expect(prompt).not.toContain('Nothing is attached');
    expect(prompt).not.toContain('Attached to this conversation');
    expect(prompt).not.toContain('read_material` on the resulting extraction');
  });

  it('does not copy names, ids, counts, extraction status, or secrets into the block', () => {
    const prompt = materialsPromptBlock(sets.mixed!);
    for (const leaked of [
      'Sample article',
      'old copy.pdf',
      'lesson.pdf',
      'Week 1',
      'src_lesson',
      'src_deck',
      'mat_web',
      'mat_copy',
      'img_1',
      'extraction running',
      '100 derivatives',
      '1 derivative',
      'secret',
      'ast_',
      'objects/',
      'textAssetId',
      'sourceUrl',
      'digest',
      '\n## Injected heading',
    ]) {
      expect(prompt, leaked).not.toContain(leaked);
    }
    expect(materialsPromptBlock(sets.injected!)).toBe(prompt);
    expect(materialsPromptBlock(sets.extractionIdle!)).toBe(
      materialsPromptBlock(sets.extractionDone!),
    );
  });
});

it('loads the chapter navigation, disclosure, clarification and read-coverage guidance', () => {
  const prompt = materialsPromptBlock([]);
  expect(prompt).toContain('use its offset to read it instead of paging from the beginning');
  expect(prompt).toContain(
    'The first time you read a chapter using the tree in a conversation, add one short sentence to your reply saying the chapters were automatically recognized from headings and may be inaccurate. No need to repeat it.',
  );
  expect(prompt).toContain(
    'If a chapter is marked "not located" but its sections have offsets, start reading at its first section with an offset.',
  );
  expect(prompt).toContain(
    'If the requested chapter is missing or ambiguous, ask the user instead of guessing',
  );
  expect(prompt).toContain('Never claim to have read parts you have not read');
});
