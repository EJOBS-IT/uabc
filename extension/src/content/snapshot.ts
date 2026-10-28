// Builds the compact page model an agent reasons about: interactive elements
// with refs, roles, names, values and states, plus optional visible text.

import type { Snapshot, SnapshotElement } from '../shared/protocol';
import {
  accessibleName, isInteractive, isRendered, labelFor, roleOf, statesOf, topRect, valueOf, walk,
  type WalkStats,
} from './dom';
import { docId, refFor } from './registry';

export interface SnapshotParams {
  mode?: 'viewport' | 'full';
  max_elements?: number;
  include_text?: boolean;
  max_text?: number;
}

export interface Candidate {
  el: Element;
  rect: DOMRect;
  position: 'in' | 'above' | 'below' | 'left' | 'right';
}

// Containers whose descendants are usually part of the same control.
const LEAF_ROLES = new Set(['link', 'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'checkbox', 'radio', 'switch', 'treeitem']);
const NATIVE_CONTROLS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Is an ancestor (crossing shadow roots) already listed as a link/button? */
function ownedBy(el: Element, owners: Set<Element>): boolean {
  for (let n: Node | null = el.parentNode; n; n = n.parentNode ?? (n as Node & { host?: Element }).host ?? null) {
    if (owners.has(n as Element)) return true;
  }
  return false;
}

function position(r: DOMRect, vw: number, vh: number): Candidate['position'] {
  if (r.bottom <= 0) return 'above';
  if (r.top >= vh) return 'below';
  if (r.right <= 0) return 'left';
  if (r.left >= vw) return 'right';
  return 'in';
}

/** Visible interactive elements in document order (shared by snapshot and marks). */
export function collect(stats: WalkStats): Candidate[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: Candidate[] = [];
  const leafOwners = new Set<Element>();
  for (const [el, frame] of walk(document, { dx: 0, dy: 0 }, stats)) {
    if (!isInteractive(el)) continue;
    let r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      // Visually hidden native checkboxes/radios are operated through their label.
      const label = labelFor(el);
      if (!label) continue;
      r = label.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
    } else if (!isRendered(el)) {
      continue;
    }
    // Skip decorative descendants of a link/button that is already listed.
    if (!NATIVE_CONTROLS.has(el.tagName) && ownedBy(el, leafOwners)) continue;
    const rect = new DOMRect(r.left + frame.dx, r.top + frame.dy, r.width, r.height);
    out.push({ el, rect, position: position(rect, vw, vh) });
    if (LEAF_ROLES.has(roleOf(el))) leafOwners.add(el);
  }
  return out;
}

function describeElement(c: Candidate): SnapshotElement {
  const { el } = c;
  const item: SnapshotElement = { ref: refFor(el), role: roleOf(el), name: accessibleName(el) };
  const value = valueOf(el);
  if (value !== undefined) item.value = value;
  const states = statesOf(el);
  if (states.length) item.states = states;
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    if (href && !href.startsWith('javascript:')) {
      try {
        const u = new URL(href, el.ownerDocument.baseURI);
        item.href = u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
      } catch {
        item.href = href;
      }
    }
  }
  if (el.tagName === 'SELECT') {
    const options = [...(el as HTMLSelectElement).options];
    item.options = options.slice(0, 12).map((o) => (o.label || o.text).trim());
    item.n_options = options.length;
  }
  if (c.position !== 'in') item.offscreen = c.position;
  return item;
}

/** Name of an open modal dialog (or a dialog overlay covering most of the viewport), else null. */
function openModal(): string | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  for (const d of document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]')) {
    if (!isRendered(d)) continue;
    const r = topRect(d);
    if (r.width < 1 || r.height < 1) continue;
    const covered = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const modal = d.matches('dialog:modal') || d.getAttribute('aria-modal') === 'true' || covered >= 0.5 * vw * vh;
    if (modal) return accessibleName(d).slice(0, 60);
  }
  return null;
}

export function scrollState() {
  const se = document.scrollingElement ?? document.documentElement;
  const state = {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    max_x: Math.max(0, se.scrollWidth - se.clientWidth),
    max_y: Math.max(0, se.scrollHeight - se.clientHeight),
  };
  if (state.max_y > 0) return state;
  // App-style layouts scroll an inner container instead of the document.
  const main = mainScroller();
  return main
    ? { x: Math.round(main.scrollLeft), y: Math.round(main.scrollTop), max_x: main.scrollWidth - main.clientWidth, max_y: main.scrollHeight - main.clientHeight }
    : state;
}

export function mainScroller(): Element | null {
  let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(s.overflowY)) return el;
  }
  return null;
}

export function snapshot(p: SnapshotParams): Snapshot {
  const max = Math.max(1, Math.min(p.max_elements ?? 150, 1000));
  const stats: WalkStats = { crossOriginFrames: 0 };
  const candidates = collect(stats);
  const elements: SnapshotElement[] = [];
  let above = 0;
  let below = 0;
  let truncated = false;
  for (const c of candidates) {
    if (p.mode !== 'full' && c.position !== 'in') {
      if (c.position === 'above') above++;
      else if (c.position === 'below') below++;
      continue;
    }
    if (elements.length >= max) {
      truncated = true;
      continue;
    }
    elements.push(describeElement(c));
  }

  const notes: string[] = [];
  if (document.readyState !== 'complete') notes.push('The page is still loading.');
  const blocking = openModal();
  if (blocking) notes.push(`A dialog is open${blocking ? ` ("${blocking}")` : ''}; elements behind it may not respond until it is closed.`);
  if (stats.crossOriginFrames > 0) {
    notes.push(
      `${stats.crossOriginFrames} embedded cross-origin frame(s) (e.g. widgets, video, payment forms) were not inspected; ` +
        'use browser_screenshot to see them and browser_click with x/y to interact.',
    );
  }

  const snap: Snapshot = {
    doc: docId,
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    scroll: scrollState(),
    elements,
    counts: { total: candidates.length, shown: elements.length, above, below, truncated },
    notes,
  };
  if (p.include_text) {
    const maxText = Math.max(100, Math.min(p.max_text ?? 6000, 100_000));
    const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    snap.text = text.length > maxText ? text.slice(0, maxText) : text;
    snap.text_truncated = text.length > maxText;
  }
  return snap;
}
