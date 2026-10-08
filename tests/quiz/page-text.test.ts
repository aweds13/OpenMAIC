/**
 * 「学生实际看得见的文字」这个单位本身。
 *
 * 为什么值得单测：它是审查 agent 的**唯一输入**。它少收一页，审查 agent 就会指着
 * 那一页说"你没讲" —— 上一轮零基础审查就是这样误报了 5 页"答案区是空的"（实测全是假的）。
 * 所以这里的每条判据都在钉"别把学生看得到的东西漏掉"，以及**别把学生看不到的东西算进来**。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  learnerVisibleText,
  renderPageHtml,
  staticPageText,
  type VisibleTextPage,
} from '@/lib/quiz/page-text';

function page(over: Partial<VisibleTextPage> & { content: unknown }): VisibleTextPage {
  return { order: 1, type: 'slide', title: 'T', ...over };
}

describe('staticPageText', () => {
  it('slide: 取文本元素与表格，且剥掉 CSS 关键词', () => {
    const text = staticPageText(
      page({
        content: {
          type: 'slide',
          canvas: {
            elements: [
              { type: 'text', content: '<p style="font-size: 32px;">byte 的<strong>范围</strong></p>' },
              { type: 'table', data: [[{ text: '运算' }, { text: '结果' }]] },
            ],
          },
        },
      }),
    );
    expect(text).toContain('byte');
    expect(text).toContain('范围');
    expect(text).toContain('运算');
    // §6.7：拿 HTML 当纯文本会把 CSS 关键词喂给模型
    expect(text).not.toContain('font-size');
    expect(text).not.toContain('strong');
  });

  it('quiz: 收题干、选项文字与解析，不收选项字母', () => {
    const text = staticPageText(
      page({
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            {
              question: '下面哪个是布尔值？',
              options: [
                { label: 'true 与 false', value: 'A' },
                { label: '1 与 0', value: 'B' },
              ],
              analysis: '布尔值只有两个字面量。',
            },
          ],
        },
      }),
    );
    expect(text).toContain('下面哪个是布尔值');
    expect(text).toContain('true 与 false');
    expect(text).toContain('布尔值只有两个字面量');
  });

  it('pbl: 收标题 / gains / 角色说明，★ 不收 roles[].systemPrompt（学生看不到）', () => {
    const content = {
      type: 'pbl',
      projectV2: {
        title: '项目②：把名单管住',
        gains: ['会用集合维护名单'],
        roles: [
          {
            name: '组长',
            description: '负责设计名单结构',
            systemPrompt: '你是评审，必须挑出学生没有做到的地方并逐条质问',
          },
        ],
      },
    };
    const text = staticPageText(page({ type: 'pbl', content }));
    expect(text).toContain('把名单管住');
    expect(text).toContain('会用集合维护名单');
    expect(text).toContain('负责设计名单结构');
    // 这是回归 pin：把 systemPrompt 收进来，审查者就会拿学生看不见的话当"讲过了"
    expect(text).not.toContain('你是评审');
    expect(text).not.toContain('逐条质问');
  });
});

describe('learnerVisibleText', () => {
  it('interactive: 渲染后拿到的才是学生看到的东西（JS 建出来的正文）', async () => {
    const html = `<!DOCTYPE html><html><body><div id="root"></div>
      <script>
        document.getElementById('root').innerHTML = '<h1>起始代码</h1><pre>int n = -7;</pre><p>参考答案：用 if 判断正负</p>';
      </script></body></html>`;
    const result = await learnerVisibleText(page({ type: 'interactive', order: 17, content: { html } }));
    expect(result.mode).toBe('rendered');
    expect(result.text).toContain('起始代码');
    expect(result.text).toContain('int n = -7;');
    expect(result.text).toContain('参考答案');
  });

  it('interactive: 脚本在 DOMContentLoaded 里抛错 ⇒ 退回源码并**说出来**，绝不假装是空页', async () => {
    // 实测第 17 页就是这个形状：CDN 的 renderMathInElement 不存在，init() 没跑完。
    // 桩表会让它跑完；这里故意用一个桩表覆盖不到的全局，验证兜底路径。
    const html = `<!DOCTYPE html><html><body><div id="root"></div>
      <script>
        document.addEventListener('DOMContentLoaded', function () { missingCdnGlobal(); });
        document.getElementById('root').innerHTML = '<p>外壳文字</p>';
      </script></body></html>`;
    const result = await learnerVisibleText(page({ type: 'interactive', content: { html } }));
    // 渲染出的是**外壳**（缺了 JS 建出来的部分）⇒ 仍然非空，所以按渲染结果给，但要带 note
    expect(result.text).toContain('外壳文字');
    expect(result.note ?? '').toMatch(/报错|脚本/);
  });

  it('interactive: 渲染拿不到任何文字 ⇒ mode=source 且有 note（不许静默成空页）', async () => {
    const html = '<!DOCTYPE html><html><body><script>document.body.remove();</script></body></html>';
    const result = await learnerVisibleText(
      page({
        type: 'interactive',
        content: { html, widgetConfig: { starterCode: 'int n = -7;', solution: 'if (n < 0) ...' } },
      }),
    );
    expect(result.mode).toBe('source');
    expect(result.text).toContain('int n = -7;');
    expect(result.note ?? '').toMatch(/不是.*学生看到/);
  });

  it('interactive: 渲染抛错（而不是渲染出空）也退回源码', async () => {
    const result = await learnerVisibleText(
      page({ type: 'interactive', content: { html: '<html><body>x</body></html>', widgetConfig: { solution: '答案' } } }),
      {
        render: async () => {
          throw new Error('jsdom 起不来');
        },
      },
    );
    expect(result.mode).toBe('source');
    expect(result.note).toContain('jsdom 起不来');
    expect(result.text).toContain('答案');
  });

  it('interactive: 没有 html 时只读结构里的文字并标注', async () => {
    const result = await learnerVisibleText(
      page({ type: 'interactive', content: { widgetConfig: { description: '题目说明' } } }),
    );
    expect(result.mode).toBe('source');
    expect(result.text).toContain('题目说明');
    expect(result.note ?? '').toMatch(/没有存 HTML/);
  });

  it('slide 不必渲染（走静态）—— 渲染只对 interactive 花钱', async () => {
    const render = vi.fn();
    const result = await learnerVisibleText(page({ content: { canvas: { elements: [{ type: 'text', content: 'hi' }] } } }), {
      render,
    });
    expect(result.mode).toBe('static');
    expect(render).not.toHaveBeenCalled();
  });
});

describe('CDN 全局桩（实测第 17 页就是靠它跑完 init()）', () => {
  it('renderMathInElement 缺失会让 init() 走不到，桩上之后正文就出来了', async () => {
    const html = `<!DOCTYPE html><html><body><div id="root"></div>
      <script>
        document.addEventListener('DOMContentLoaded', function () {
          renderMathInElement(document.body);   // 页面从 CDN 引的全局
          document.getElementById('root').innerHTML = '<p>闰年判断：year % 4 == 0</p>';
        });
      </script></body></html>`;
    const { text, errors } = await renderPageHtml(html);
    expect(text).toContain('闰年判断');
    expect(errors.join(' ')).not.toMatch(/renderMathInElement/);
  });
});
