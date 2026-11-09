import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `/review` 必须能从产品里点进去。
 *
 * 为什么单独钉这一条：复习闭环的写侧、降级规则、读侧与页面都在 2026-11-10 落了地，
 * 但**「到他手上」这一步当时是缺的** —— `app/review/page.tsx` 存在、路由 200、
 * 数据也对，可产品里没有任何地方指向它。这种缺口在单元测试里看不见（每个模块
 * 自己都对），只有「谁链到谁」这一层能看见。
 *
 * 判据从源码读，不渲染：`app/page.tsx` 是 2400 行的客户端页面，为一个链接把它
 * 挂进 jsdom 代价不成比例，而这里要守的恰恰是**那个 `<a href>` 还在不在**。
 */
const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('复习页有入口', () => {
  it('首页顶部工具条里有指向 /review 的链接', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('href="/review"');
    expect(page).toContain('data-testid="home-review-link"');
  });

  it('★ 链接的 aria-label 来自 locale，不是硬写的中文', () => {
    const page = read('app/page.tsx');
    const anchor = page.slice(page.indexOf('home-review-link'));
    const block = anchor.slice(0, 600);
    expect(block).toContain("t('review.title')");
  });

  it('★ 入口上带一个到期角标，而且它挂在链接里', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('DueReviewBadge');
    const start = page.indexOf('data-testid="home-review-link"');
    const end = page.indexOf('</Link>', start);
    expect(end).toBeGreaterThan(start);
    // 角标必须在 `<Link>` 里面 —— 挂到页面上别处就变成一个孤立的数字，
    // 没人知道它属于哪个入口。
    expect(page.slice(start, end)).toContain('<DueReviewBadge />');
  });

  it('★ 角标能锚在图标右上角（链接要 relative，否则它跑到页面角落）', () => {
    const page = read('app/page.tsx');
    const start = page.indexOf('data-testid="home-review-link"');
    const block = page.slice(start, page.indexOf('</Link>', start));
    expect(block).toContain('relative');
  });

  it('复习页本身仍然是动态渲染（不许被静态化成一份过期列表）', () => {
    const reviewPage = read('app/review/page.tsx');
    expect(reviewPage).toContain("export const dynamic = 'force-dynamic'");
  });
});

/**
 * `/ai-log` 同样必须能从产品里点进去。
 *
 * 与 `/review` 那条同一类缺口、同一层判据：页面存在、路由 200、数据也对，
 * 但只要没人链过去，用户就永远看不到。区别只有一条 —— **它不该有角标**：
 * 日志是往回看的，不存在「今天该看几条」，加个数字只会教人去凑数。
 */
describe('对话日志页有入口', () => {
  it('首页顶部工具条里有指向 /ai-log 的链接', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('href="/ai-log"');
    expect(page).toContain('data-testid="home-ai-log-link"');
  });

  it('★ 链接的 aria-label 来自 locale，不是硬写的中文', () => {
    const page = read('app/page.tsx');
    const anchor = page.slice(page.indexOf('home-ai-log-link'));
    const block = anchor.slice(0, 600);
    expect(block).toContain("t('aiLog.title')");
  });

  it('★ 它不带角标 —— 日志没有「今天该看几条」这回事', () => {
    const page = read('app/page.tsx');
    const start = page.indexOf('data-testid="home-ai-log-link"');
    const end = page.indexOf('</Link>', start);
    expect(end).toBeGreaterThan(start);
    expect(page.slice(start, end)).not.toContain('Badge');
  });

  it('两个入口都在同一条工具条里', () => {
    const page = read('app/page.tsx');
    const tools = page.indexOf('home-top-tools');
    const review = page.indexOf('data-testid="home-review-link"');
    const aiLog = page.indexOf('data-testid="home-ai-log-link"');
    expect(tools).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(tools);
    expect(aiLog).toBeGreaterThan(tools);
  });
});
