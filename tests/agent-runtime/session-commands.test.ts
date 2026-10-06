/**
 * Composer commands.
 *
 * The parser decides whether a turn carries `/compact`, so its edge cases are
 * the whole feature: a false positive compacts when nobody asked, and a false
 * negative makes the manual gear silently do nothing. Paths and skill handles
 * are the two things most likely to be mistaken for a command, so they are
 * pinned explicitly.
 */
import { describe, expect, it } from 'vitest';

import {
  readSessionCommand,
  readSessionCommandFrom,
  SESSION_COMMANDS,
} from '@/lib/server/agent-runtime/session-commands';

describe('readSessionCommand', () => {
  it('recognises the command alone and at a word boundary', () => {
    expect(readSessionCommand('/compact')).toBe('compact');
    expect(readSessionCommand('/compact ')).toBe('compact');
    expect(readSessionCommand('  /compact')).toBe('compact');
    expect(readSessionCommand('\n/compact\n')).toBe('compact');
    expect(readSessionCommand('先压一下 /compact 然后继续建第 3 页')).toBe('compact');
  });

  it('is case-insensitive', () => {
    expect(readSessionCommand('/Compact')).toBe('compact');
    expect(readSessionCommand('/COMPACT')).toBe('compact');
  });

  it('ignores a path that merely contains the word', () => {
    // The reason the pattern anchors on whitespace rather than using \b:
    // `docs/compact` is a path, and compacting because someone mentioned one
    // would be a surprising, expensive false positive.
    expect(readSessionCommand('look at docs/compact')).toBeNull();
    expect(readSessionCommand('./compact')).toBeNull();
    expect(readSessionCommand('src/compact/index.ts')).toBeNull();
  });

  it('ignores a longer token that merely starts with the name', () => {
    expect(readSessionCommand('/compactx')).toBeNull();
    expect(readSessionCommand('/compact-all')).toBeNull();
  });

  it('leaves skill handles to the skill path', () => {
    // The composer's `/` menu is a SKILL registry; those handles must reach
    // skill-preload untouched.
    expect(readSessionCommand('/pro-editing')).toBeNull();
    expect(readSessionCommand('/stage-design rewrite page 4')).toBeNull();
  });

  it('finds a command even when a skill handle comes first', () => {
    expect(readSessionCommand('/stage-design /compact rewrite page 4')).toBe('compact');
  });

  it('exports exactly the command it recognises', () => {
    expect([...SESSION_COMMANDS]).toContain('compact');
  });
});

describe('readSessionCommandFrom', () => {
  it('scans every pending message and skips blanks', () => {
    expect(readSessionCommandFrom([undefined, '', 'hello'])).toBeNull();
    expect(readSessionCommandFrom([undefined, 'hello', '/compact'])).toBe('compact');
    expect(readSessionCommandFrom([])).toBeNull();
  });
});
