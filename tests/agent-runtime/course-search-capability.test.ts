/**
 * `resolveCourseSearchCapability` 的 env 解析规则。
 *
 * 单独一个文件，**不 mock 任何东西** —— 测的就是真实实现。
 * （在 runner-course-search-registration.test.ts 里这个模块被 mock 了，
 *  在那里 importActual 会踩 Vite 的模块解析，所以分开。）
 *
 * 这些规则的意义：返回 null 就是"不注册工具"。所以一个假的真值会让模型
 * 拿到一个一调就死的工具；一个假的 null 会让本地课程库永远用不上。
 * 两种都是静默失败，必须钉住。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { resolveCourseSearchCapability } from '@/lib/server/agent-runtime/course-search';

const PREV = process.env.OPENMAIC_COURSE_SEARCH_URL;

afterEach(() => {
  if (PREV === undefined) delete process.env.OPENMAIC_COURSE_SEARCH_URL;
  else process.env.OPENMAIC_COURSE_SEARCH_URL = PREV;
});

describe('resolveCourseSearchCapability', () => {
  it('returns the base URL when configured', () => {
    process.env.OPENMAIC_COURSE_SEARCH_URL = 'http://127.0.0.1:8720';
    expect(resolveCourseSearchCapability()).toEqual({ baseUrl: 'http://127.0.0.1:8720' });
  });

  it('trims surrounding whitespace', () => {
    process.env.OPENMAIC_COURSE_SEARCH_URL = '  http://127.0.0.1:8720  ';
    expect(resolveCourseSearchCapability()).toEqual({ baseUrl: 'http://127.0.0.1:8720' });
  });

  it('is null when unset or blank', () => {
    delete process.env.OPENMAIC_COURSE_SEARCH_URL;
    expect(resolveCourseSearchCapability()).toBeNull();

    process.env.OPENMAIC_COURSE_SEARCH_URL = '   ';
    expect(resolveCourseSearchCapability()).toBeNull();
  });

  it('rejects a value that is not an http(s) URL', () => {
    // 'localhost:8720' 是个常见手滑（漏了 scheme）。放行它会让工具注册成功、
    // 调用时才炸 —— 静默失败比直接不注册难查得多，所以这里就拒。
    process.env.OPENMAIC_COURSE_SEARCH_URL = 'localhost:8720';
    expect(resolveCourseSearchCapability()).toBeNull();
  });

  it('accepts https', () => {
    process.env.OPENMAIC_COURSE_SEARCH_URL = 'https://library.example';
    expect(resolveCourseSearchCapability()).toEqual({ baseUrl: 'https://library.example' });
  });
});
