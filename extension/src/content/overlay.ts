// Set-of-Marks: numbered badges over interactive elements, drawn only for the
// instant a screenshot is taken. They live in a closed shadow root with
// `pointer-events: none`, so page CSS cannot restyle them and they never
// intercept clicks.

import type { WalkStats } from './dom';
import { docId, refFor } from './registry';
import { collect } from './snapshot';

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000', '#000075', '#c71585'];

let host: HTMLElement | null = null;

export function showMarks(max = 300): { doc: string; marks: number } {
  hideMarks();
  const stats: WalkStats = { crossOriginFrames: 0 };
  const visible = collect(stats).filter((c) => c.position === 'in').slice(0, max);

  host = document.createElement('uabc-marks');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = document.createElement('style');
  sheet.textContent = `
    .box{position:fixed;box-sizing:border-box;border:2px solid var(--c);border-radius:3px;}
    .tag{position:absolute;left:-2px;top:-2px;transform:translateY(-100%);background:var(--c);color:#fff;
      font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 3px;border-radius:3px 3px 3px 0;
      white-space:nowrap;}
    .box.low .tag{transform:none;top:0;border-radius:0 0 3px 0;}`;
  root.append(sheet);
  for (const { el, rect } of visible) {
    const ref = refFor(el);
    const box = document.createElement('div');
    box.className = rect.top < 16 ? 'box low' : 'box';
    box.style.cssText = `--c:${COLORS[Number(ref) % COLORS.length]};left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = ref;
    box.append(tag);
    root.append(box);
  }
  document.documentElement.append(host);
  return { doc: docId, marks: visible.length };
}

export function hideMarks(): void {
  host?.remove();
  host = null;
}
