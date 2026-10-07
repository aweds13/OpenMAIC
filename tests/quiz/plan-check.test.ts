import { describe, expect, it } from 'vitest';

import { checkPlanDependencies, formatPlanIssues, type PlanEntryLike } from '@/lib/quiz/plan-check';

function page(
  order: number,
  type: string,
  title: string,
  extra: { description?: string; keyPoints?: string[] } = {},
): PlanEntryLike {
  return { order, type, title, ...extra };
}

describe('checkPlanDependencies', () => {
  it('says nothing about a plan that teaches before it tests', () => {
    const issues = checkPlanDependencies([
      page(1, 'slide', '类与对象', { description: '类是模板，对象是实例' }),
      page(2, 'slide', '封装', { description: 'private 字段 + getter setter' }),
      page(3, 'quiz', '小测', { description: '考封装：private 字段怎么读' }),
    ]);
    expect(issues).toEqual([]);
  });

  it('flags a quiz whose concept is only taught LATER (the ordering case)', () => {
    // ★ 这是第一版判据抓不到的：那个词的"第一次出现"就是这张自检页本身，
    //   所以"第一次出现 > 本页"永远为假。正确判据是"讲它的是哪一页"。
    const issues = checkPlanDependencies([
      page(1, 'slide', '类与对象', { description: '类是模板' }),
      page(2, 'quiz', '小测', { description: '考多态：父类引用指向子类对象' }),
      page(3, 'slide', '多态', { description: '多态：父类引用指向子类对象' }),
    ]);

    const forward = issues.find((issue) => issue.kind === 'forward-reference');
    expect(forward).toBeDefined();
    expect(forward?.orders).toEqual([2, 3]);
    expect(forward?.message).toContain('挪到讲解之后');
    // 修法必须是"挪/提前"，不许是"删"。
    expect(forward?.message).toContain('不要删掉这道题');
  });

  it('flags a quiz that no teaching page ever covers', () => {
    // 形状是刻意的：真概念**会重复出现**（这道考、那道也考），而口气话只出现一次。
    const issues = checkPlanDependencies([
      page(1, 'slide', '类与对象', { description: '类是模板' }),
      page(2, 'quiz', '小测一', { description: '考动态绑定和消息传递' }),
      page(3, 'quiz', '小测二', { description: '再考一次动态绑定和消息传递' }),
    ]);

    const orphan = issues.find((issue) => issue.kind === 'unintroduced');
    expect(orphan).toBeDefined();
    expect(orphan?.message).toContain('补一页讲解');
    expect(orphan?.message).toContain('题可以原样留着');
  });

  it('does not count another quiz page as teaching', () => {
    // 两道自检互相"提到"同一个词，但没有任何讲解页讲它 ⇒ 仍然是没讲就考。
    const issues = checkPlanDependencies([
      page(1, 'quiz', '小测一', { description: '考动态绑定' }),
      page(2, 'quiz', '小测二', { description: '再考动态绑定' }),
    ]);
    expect(issues.filter((issue) => issue.kind === 'unintroduced')).toHaveLength(2);
  });

  it('flags a page that introduces too many concepts at once, and says "split"', () => {
    const issues = checkPlanDependencies(
      [
        page(1, 'slide', 'OOP 一页讲完', {
          description: '类 对象 封装 继承 多态 组合 抽象 接口 重写 动态绑定',
        }),
      ],
      { conceptsPerPage: 3 },
    );

    const budget = issues.find((issue) => issue.kind === 'budget');
    expect(budget).toBeDefined();
    expect(budget?.message).toContain('拆成 2–3 页');
    // 方向：不许砍概念。
    expect(budget?.message).toContain('不要砍掉其中任何一个概念');
  });

  it('honours conceptsPerPage', () => {
    // ★ 这里刻意用"阈值"而不是"块数"断言：块数不等于概念数（实测「两三个概念」
    //   会切成「两三」「概念」两个块），所以任何对这个数字的精确假设都是错的。
    const plan = [page(1, 'slide', '一页', { description: '甲甲 乙乙 丙丙' })];
    expect(checkPlanDependencies(plan, { conceptsPerPage: 1 }).length).toBeGreaterThan(0);
    expect(checkPlanDependencies(plan, { conceptsPerPage: 99 })).toHaveLength(0);
  });

  it('lets a later page reuse what an earlier page established without complaint', () => {
    const issues = checkPlanDependencies([
      page(1, 'slide', '封装', { description: 'private getter setter' }),
      page(2, 'slide', '继承', { description: 'extends 复用 private getter setter' }),
      page(3, 'quiz', '小测', { description: '考 private 与 getter' }),
    ]);
    expect(issues).toEqual([]);
  });

  it('sorts issues by page order', () => {
    // 每个概念都出现两页（满足重复闸），这样钉的就只是"排序"这一件事。
    const issues = checkPlanDependencies([
      page(5, 'quiz', '后面的', { description: '考抽象' }),
      page(6, 'quiz', '还是后面的', { description: '再考抽象' }),
      page(1, 'quiz', '前面的', { description: '考多态' }),
      page(2, 'quiz', '还是前面的', { description: '再考多态' }),
    ]);
    expect(issues.map((issue) => issue.orders[0])).toEqual([1, 2, 5, 6]);
  });

  it('leaves the budget rule OFF unless a threshold is given', () => {
    // 内容块 ≠ 概念（「封装 private 字段 getter setter」是 5 个块、1 个概念），
    // 而 T1 之前计划永远是空的 ⇒ 没有真实数据可以标定。所以默认不检查。
    const plan = [page(1, 'slide', '封装', { description: 'private 字段 getter setter 都要讲' })];
    expect(checkPlanDependencies(plan)).toEqual([]);
    expect(checkPlanDependencies(plan, { conceptsPerPage: 2 })).toHaveLength(1);
  });

  it('treats "考封装" as covered when a teaching page teaches "封装"', () => {
    // 块包含判据的 pin：整块相等会把自检页的口气话报成"没讲就考"。
    const issues = checkPlanDependencies([
      page(1, 'slide', '封装', { description: '封装是把数据藏起来' }),
      page(2, 'quiz', '小测一', { description: '考封装' }),
      page(3, 'quiz', '小测二', { description: '再考封装' }),
    ]);
    expect(issues).toEqual([]);
  });

  it('ignores pages with no plan text at all', () => {
    expect(checkPlanDependencies([page(1, 'slide', '空页')])).toEqual([]);
  });

  it('can restrict which page types count as assessments', () => {
    const plan = [
      page(1, 'slide', '类', { description: '类是模板' }),
      page(2, 'interactive', '动手', { description: '考动态绑定' }),
    ];
    expect(checkPlanDependencies(plan).some((i) => i.kind === 'unintroduced')).toBe(false);
    // minPages 显式给 1：这条测试只钉"哪些类型算考核"，不夹带频率闸。
    expect(
      checkPlanDependencies(plan, { assessedTypes: ['interactive'], minPages: 1 }).some(
        (i) => i.kind === 'unintroduced',
      ),
    ).toBe(true);
  });
});

describe('formatPlanIssues', () => {
  it('says nothing for no issues', () => {
    expect(formatPlanIssues([])).toBe('');
  });

  it('states the only-allowed repairs are add/move — never delete', () => {
    const text = formatPlanIssues([
      { kind: 'unintroduced', orders: [2], message: '第 2 页要考抽象' },
    ]);
    expect(text).toContain('计划');
    expect(text).toContain('只允许"补"和"挪"');
    expect(text).toContain('不允许删题、砍概念');
    expect(text).toContain('越修越薄');
  });

  it('caps the list and says how many are left', () => {
    const issues = Array.from({ length: 4 }, (_, index) => ({
      kind: 'unintroduced' as const,
      orders: [index + 1],
      message: `第 ${index + 1} 页`,
    }));
    const text = formatPlanIssues(issues, { max: 2 });
    expect(text).toContain('第 1 页');
    expect(text).toContain('第 2 页');
    expect(text).not.toContain('第 3 页');
    expect(text).toContain('还有 2 处');
  });
});
