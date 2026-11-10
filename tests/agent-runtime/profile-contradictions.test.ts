import { describe, expect, it } from 'vitest';
import {
  domainTokens,
  findProfileContradictions,
  parseUnknownDomains,
} from '@/lib/server/agent-runtime/profile-contradictions';

/**
 * 这一组的每一条都在钉一个**判断**，不是钉实现：
 *
 *   · 哪些行算「画像说不知道」（知识状态表里整格 UNKNOWN，不是正文里的 UNKNOWN：）
 *   · 域怎么切成词（合称要拆开，单字不许留）
 *   · 什么算「状态说知道」（只有非 unknown 的格算）
 *   · 命中的边界（标题里包含 vs 只是同一门课）
 *
 * 真库形状写在每条的注释里：画像 1851 B、库里有 234 页 —— 这些数字会漂，
 * 所以判据只用**手搭的最小输入**，不读真文件。
 */

const PROFILE = [
  '# Learner Profile',
  '',
  '## 身份',
  '',
  '计算机专业大一。',
  '',
  '## 知识状态',
  '',
  '| 领域 | 状态 | 证据 |',
  '| --- | --- | --- |',
  '| 程序设计基础 | 在学，进度到「变量」 | 天津大学 week_2 |',
  '| Git | 已接触 | week_1 |',
  '| Java | UNKNOWN | 仅知是后端组要求 |',
  '| Dart / Flutter | UNKNOWN | 仅知是移动组要求 |',
  '',
  '## 掌握度（1–5，自己填）',
  '',
  '**未测定。**',
].join('\n');

describe('parseUnknownDomains', () => {
  it('★ 只认知识状态表里整格 UNKNOWN 的行 —— 正文里那种不是领域', () => {
    const profile = [
      '## 目标',
      'UNKNOWN：长期目标是打地基还是应试突击',
      '',
      '## 知识状态',
      '| 领域 | 状态 | 证据 |',
      '| --- | --- | --- |',
      '| Java | UNKNOWN | 后端组要求 |',
    ].join('\n');

    // 正文里的 `UNKNOWN：…` 是「这个问题没答」，不是「这个领域不知道」——
    // 页标题里不会出现「长期目标」，收进来只会造出永远不可能命中的词。
    expect(parseUnknownDomains(profile)).toEqual(['Java']);
  });

  it('两个 UNKNOWN 领域都收，且保持原顺序', () => {
    expect(parseUnknownDomains(PROFILE)).toEqual(['Java', 'Dart / Flutter']);
  });

  it('状态列是「在学」「已接触」的不收', () => {
    const onlyKnownish = PROFILE.replace('| Java | UNKNOWN |', '| Java | 在学 |');
    expect(parseUnknownDomains(onlyKnownish)).toEqual(['Dart / Flutter']);
  });

  it('没有知识状态小节就是空的，不抛', () => {
    expect(parseUnknownDomains('# 空画像\n')).toEqual([]);
    expect(parseUnknownDomains('')).toEqual([]);
  });

  it('表头与分隔行不算数据行', () => {
    // `| 领域 | 状态 | 证据 |` 的状态列是「状态」，不是 UNKNOWN；`---` 同理。
    expect(parseUnknownDomains(PROFILE)).not.toContain('状态');
    expect(parseUnknownDomains(PROFILE)).not.toContain('---');
  });
});

describe('domainTokens', () => {
  it('★ 合称要拆开 —— 「Dart / Flutter」是两个词', () => {
    expect(domainTokens('Dart / Flutter')).toEqual(['Dart', 'Flutter']);
  });

  it('中文分隔符也切，且去空白', () => {
    expect(domainTokens('WSL2、 开发环境')).toEqual(['WSL2', '开发环境']);
  });

  it('★ 短于两个字符的词整条丢掉 —— 单字会命中几乎所有标题', () => {
    // 单字「的」会命中「自检：Dart 的语法」，那种证据会让人开始忽略这个检测。
    expect(domainTokens('C / 的 / 语')).toEqual([]);
  });

  it('空串与纯分隔符回空数组', () => {
    expect(domainTokens('')).toEqual([]);
    expect(domainTokens(' / ， 、')).toEqual([]);
  });
});

describe('findProfileContradictions', () => {
  const cells = [
    {
      stageId: 'stage-A',
      sceneId: 'scene-p24',
      title: '自检：Dart 进阶八道题',
      tri: 'known',
    },
    { stageId: 'stage-A', sceneId: 'scene-p18', title: '自检：Dart 语法八道题', tri: 'unknown' },
    { stageId: 'stage-B', sceneId: 'scene-p7', title: 'Git 自检：十道题（易 → 难）', tri: 'known' },
  ];

  it('★ 画像说不知道、状态说知道 —— 这才叫矛盾', () => {
    const found = findProfileContradictions({ profile: PROFILE, cells });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      domain: 'Dart / Flutter',
      token: 'Dart',
      stageId: 'stage-A',
      sceneId: 'scene-p24',
      tri: 'known',
    });
  });

  it('★ unknown 的格不算矛盾 —— 「不知道」和「不知道」对得上', () => {
    const found = findProfileContradictions({ profile: PROFILE, cells });
    expect(found.map((item) => item.sceneId)).not.toContain('scene-p18');
  });

  it('★ 画像里非 UNKNOWN 的领域不许触发（Git 已接触，判出 known 也不冲突）', () => {
    const found = findProfileContradictions({ profile: PROFILE, cells });
    expect(found.map((item) => item.domain)).not.toContain('Git');
  });

  it('Java 在标题里一次都没出现 —— 零命中就是零命中，不编', () => {
    // 真库实测：`Java` 在 `xq_concept` 与 `xq_concept_alias` 上 0 命中，
    // 页标题里也只有 3 页带 java（都在另一门课）。这里手搭的输入里一页都没有。
    const found = findProfileContradictions({ profile: PROFILE, cells });
    expect(found.map((item) => item.domain)).not.toContain('Java');
  });

  it('★ 匹配不分大小写（标题里写 dart、画像里写 Dart）', () => {
    const found = findProfileContradictions({
      profile: PROFILE,
      cells: [{ stageId: 's', sceneId: 'p1', title: 'dart 自检', tri: 'known' }],
    });
    expect(found).toHaveLength(1);
  });

  it('not-learned 的格也算矛盾「画像是 UNKNOWN，状态说没达到」', () => {
    const found = findProfileContradictions({
      profile: PROFILE,
      cells: [{ stageId: 's', sceneId: 'p1', title: 'Dart 语法自检', tri: 'not-learned' }],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.tri).toBe('not-learned');
  });

  it('没有标题的格跳过 —— 没标题就无从比对', () => {
    const found = findProfileContradictions({
      profile: PROFILE,
      cells: [
        { stageId: 's', sceneId: 'p1', title: null, tri: 'known' },
        { stageId: 's', sceneId: 'p2', title: '   ', tri: 'known' },
      ],
    });
    expect(found).toEqual([]);
  });

  it('画像里没有任何 UNKNOWN 就是空的', () => {
    const found = findProfileContradictions({
      profile: PROFILE.replace(/UNKNOWN \|/g, '在学 |'),
      cells,
    });
    expect(found).toEqual([]);
  });

  it('★ 排序稳定：先按领域，再按 page —— 两次同样的输入不许两种顺序', () => {
    const many = [
      { stageId: 'stage-B', sceneId: 'scene-p7', title: 'Git 自检', tri: 'known' },
      { stageId: 'stage-A', sceneId: 'scene-p9', title: 'Dart 与 Git 混排', tri: 'known' },
      { stageId: 'stage-A', sceneId: 'scene-p1', title: 'Dart 语法', tri: 'known' },
    ];
    const once = findProfileContradictions({ profile: PROFILE, cells: many });
    const twice = findProfileContradictions({ profile: PROFILE, cells: [...many].reverse() });
    expect(once.map((item) => `${item.domain}|${item.sceneId}`)).toEqual(
      twice.map((item) => `${item.domain}|${item.sceneId}`),
    );
  });

  it('同一个 domain 命中多页时一条不少（每页都要能查到）', () => {
    const found = findProfileContradictions({
      profile: PROFILE,
      cells: [
        { stageId: 'stage-A', sceneId: 'scene-p1', title: 'Dart 语法自检', tri: 'known' },
        { stageId: 'stage-A', sceneId: 'scene-p2', title: 'Dart 进阶自检', tri: 'known' },
      ],
    });
    expect(found).toHaveLength(2);
  });

  it('领域空、格空时都回空数组，不抛', () => {
    expect(findProfileContradictions({ profile: '', cells: [] })).toEqual([]);
    expect(findProfileContradictions({ profile: PROFILE, cells: [] })).toEqual([]);
  });
});
