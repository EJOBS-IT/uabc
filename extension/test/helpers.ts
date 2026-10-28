// Shared test helpers.

import { expect } from 'vitest';

const FENCE = 'untrusted-web-content';
/** Every occurrence of `needle` must sit inside a fence, and fences must balance. */
export function assertFenced(out: string, needle: string): void {
  const opens = out.split(`<${FENCE} `).length - 1;
  const closes = out.split(`</${FENCE}>`).length - 1;
  expect(opens, `unbalanced fences in:\n${out}`).toBe(closes);
  let depth = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith(`<${FENCE} `)) depth++;
    else if (line === `</${FENCE}>`) depth--;
    else if (line.includes(needle)) expect(depth, `unfenced page text in line ${JSON.stringify(line)} of:\n${out}`).toBe(1);
  }
}

