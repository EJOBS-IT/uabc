import { describe, expect, it } from 'vitest';
import { parseChord } from '../src/shared/keys';

describe('parseChord', () => {
  it('parses named keys with their CDP codes', () => {
    const c = parseChord('Enter');
    expect(c.key).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(c.mask).toBe(0);
  });

  it('builds the modifier mask and drops text for shortcuts', () => {
    const c = parseChord('ctrl+shift+k');
    expect(c.modifiers).toEqual(['Control', 'Shift']);
    expect(c.mask).toBe(2 | 8);
    expect(c.key).toMatchObject({ code: 'KeyK', keyCode: 75 });
    expect(c.key.text).toBeUndefined();
  });

  it('types upper-case letters with Shift', () => {
    expect(parseChord('Shift+a').key).toMatchObject({ key: 'A', text: 'A' });
  });

  it('understands aliases and ControlOrMeta per platform', () => {
    expect(parseChord('Esc').key.key).toBe('Escape');
    expect(parseChord('cmd+a', true).commands).toEqual(['selectAll']);
    expect(parseChord('ControlOrMeta+a', false).modifiers).toEqual(['Control']);
    expect(parseChord('ControlOrMeta+a', true).modifiers).toEqual(['Meta']);
    expect(parseChord('Meta+a', false).commands).toEqual([]);
  });

  it('handles the plus key', () => {
    expect(parseChord('+').key.text).toBe('+');
    expect(parseChord('Control++').key.key).toBe('+');
  });

  it('passes non-Latin characters through as text', () => {
    expect(parseChord('ক').key).toMatchObject({ key: 'ক', text: 'ক', keyCode: 0 });
  });

  it('rejects nonsense', () => {
    expect(() => parseChord('')).toThrow();
    expect(() => parseChord('Banana+K')).toThrow(/not a modifier/);
    expect(() => parseChord('Control+Banana')).toThrow(/unknown key/);
  });
});
