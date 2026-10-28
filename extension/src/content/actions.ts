// Content-side halves of the actions. In trusted mode the content script only
// *locates* things (scroll into view, hit-test, focus) and the service worker
// sends real input through the DevTools protocol. In basic mode (no debugger,
// e.g. blocked by enterprise policy) the fallbacks below synthesize events.

import { type ActionPoint, CommandError, Code } from '../shared/protocol';

/** An error whose message quotes the page (element names): the MCP layer fences it. */
const pageError = (code: Code, message: string, hint?: string) => new CommandError(code, message, hint, true);
import {
  accessibleName, composedContains, deepActiveElement, deepElementFromPoint, describe, isDisabled, isSensitive,
  isTextField, labelFor, roleOf, topRect, valueOf,
} from './dom';
import { docId, resolveTarget, type TargetParams } from './registry';
import { mainScroller, scrollState } from './snapshot';

function label(el: Element): string {
  const name = accessibleName(el);
  return `${roleOf(el)}${name ? ` "${name.slice(0, 60)}"` : ''}`;
}

function scrollIntoView(el: Element): void {
  // Scroll the iframe chain first so the element can actually reach the viewport.
  const frames: Element[] = [];
  for (let w = el.ownerDocument.defaultView; w && w !== window.top && w.frameElement; w = w.frameElement.ownerDocument.defaultView) {
    frames.unshift(w.frameElement);
  }
  for (const f of frames) f.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}

/** Where a real click on `el` would land, after making sure nothing covers it. */
export function actionPoint(el: Element): ActionPoint {
  if (isDisabled(el)) {
    throw pageError(Code.NOT_INTERACTABLE, `${label(el)} is disabled.`, 'Complete the required steps first, or pick another element.');
  }
  scrollIntoView(el);
  let target = el;
  let r = topRect(el);
  if (r.width < 1 || r.height < 1) {
    const lbl = labelFor(el);
    if (!lbl) throw pageError(Code.NOT_INTERACTABLE, `${label(el)} has no visible size.`, 'It may be hidden; call browser_get_state.');
    target = lbl;
    r = topRect(lbl);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spots: Array<[number, number]> = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];
  for (const [fx, fy] of spots) {
    const x = Math.min(Math.max(r.left + r.width * fx, 1), vw - 1);
    const y = Math.min(Math.max(r.top + r.height * fy, 1), vh - 1);
    const hit = deepElementFromPoint(document, x, y);
    if (hit && (composedContains(target, hit) || composedContains(el, hit) || labelFor(el) === hit || composedContains(labelFor(el) ?? el, hit))) {
      return { doc: docId, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, description: label(el) };
    }
  }
  const blocker = deepElementFromPoint(document, r.left + r.width / 2, r.top + r.height / 2);
  throw pageError(
    Code.OBSCURED,
    `${label(el)} is covered by ${describe(blocker)}.`,
    'Close or dismiss that element first (cookie banner, dialog, menu), or scroll so it is not under a sticky header.',
  );
}

export function locate(p: TargetParams): ActionPoint {
  return actionPoint(resolveTarget(p));
}

/** What would be hit at a viewport point (for coordinate clicks). */
export function describeAt(x: number, y: number): { doc: string; description: string; sensitive: boolean } {
  const hit = deepElementFromPoint(document, x, y);
  return { doc: docId, description: hit ? label(hit) : 'nothing', sensitive: !!hit && isSensitive(hit) };
}

function editableWithin(el: Element): Element | null {
  if (isTextField(el)) return el;
  if (el.tagName === 'LABEL') {
    const control = (el as HTMLLabelElement).control;
    if (control && isTextField(control)) return control;
  }
  const inner = el.querySelector('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable="true"]');
  return inner && isTextField(inner) ? inner : null;
}

function selectContents(el: Element, all: boolean): void {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const field = el as HTMLInputElement;
    if (all) field.select();
    else {
      try {
        field.setSelectionRange(field.value.length, field.value.length);
      } catch {
        // email/number inputs do not support selection ranges; caret stays put
      }
    }
    return;
  }
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  sel.selectAllChildren(el);
  if (!all) sel.collapseToEnd();
}

/** Focuses a text field and selects what typing should replace. */
export function prepareType(p: TargetParams & { clear?: boolean }): ActionPoint & { kind: string } {
  const picked = resolveTarget(p);
  const el = editableWithin(picked);
  if (!el) {
    throw pageError(Code.NOT_INTERACTABLE, `${label(picked)} is not a text field.`, 'Pick an element whose role is textbox, searchbox or combobox.');
  }
  if (isSensitive(el)) {
    throw pageError(
      Code.SENSITIVE_FIELD,
      `${label(el)} is a password, one-time-code or payment field. UABC never types into or reads such fields.`,
      'Ask the user to fill in this field themselves, then continue.',
    );
  }
  if (isDisabled(el) || (el as HTMLInputElement).readOnly === true) {
    throw pageError(Code.NOT_INTERACTABLE, `${label(el)} is disabled or read-only.`);
  }
  scrollIntoView(el);
  (el as HTMLElement).focus({ preventScroll: true });
  if (!composedContains(el, deepActiveElement())) {
    throw pageError(Code.NOT_INTERACTABLE, `${label(el)} cannot receive keyboard focus.`, 'Try clicking it first.');
  }
  selectContents(el, p.clear !== false);
  const r = topRect(el);
  return {
    doc: docId,
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    description: label(el),
    kind: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? 'field' : 'contenteditable',
  };
}

/** What has keyboard focus (used to refuse key presses into sensitive fields). */
export function focusInfo(): { doc: string; sensitive: boolean; opaqueFrame: boolean; singleLine: boolean } {
  const el = deepActiveElement();
  // Focus inside a cross-origin frame (e.g. a payment widget) cannot be inspected.
  const opaqueFrame = !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME');
  return { doc: docId, sensitive: !!el && isSensitive(el), opaqueFrame, singleLine: el?.tagName === 'INPUT' };
}

/** Value of the focused field after typing (redacted when sensitive). */
export function focusedValue(): { value?: string } {
  const el = deepActiveElement();
  return el ? { value: valueOf(el) } : {};
}

export function selectOptions(p: TargetParams & { values: string[] }): { doc: string; selected: string[] } {
  const el = resolveTarget(p);
  if (el.tagName !== 'SELECT') {
    throw pageError(
      Code.NOT_INTERACTABLE,
      `${label(el)} is not a native <select>.`,
      'For custom dropdowns, browser_click the dropdown, then browser_click the option.',
    );
  }
  const select = el as HTMLSelectElement;
  if (isDisabled(select)) throw pageError(Code.NOT_INTERACTABLE, `${label(el)} is disabled.`);
  const wanted = (p.values ?? []).map((v) => v.trim().toLowerCase());
  if (wanted.length === 0) throw new CommandError(Code.INVALID_PARAMS, 'Pass at least one value.');
  if (wanted.length > 1 && !select.multiple) throw pageError(Code.INVALID_PARAMS, `${label(el)} accepts a single choice.`);
  const options = [...select.options];
  const chosen = wanted.map((w) => {
    const hit = options.find((o) => (o.label || o.text).trim().toLowerCase() === w) ?? options.find((o) => o.value.toLowerCase() === w);
    if (!hit) {
      const names = options.slice(0, 20).map((o) => (o.label || o.text).trim()).join(', ');
      throw pageError(
        Code.NO_SUCH_OPTION,
        `No option "${w}" in ${label(el)}. Available: ${names}${options.length > 20 ? ', …' : ''}`,
        'Use one of the available option labels.',
      );
    }
    if (hit.disabled) throw pageError(Code.NOT_INTERACTABLE, `Option "${hit.text.trim()}" is disabled.`);
    return hit;
  });
  scrollIntoView(select);
  select.focus({ preventScroll: true });
  for (const o of options) o.selected = chosen.includes(o);
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { doc: docId, selected: chosen.map((o) => (o.label || o.text).trim()) };
}

export function scroll(p: TargetParams & { direction: string; amount?: number }) {
  const vertical = p.direction === 'up' || p.direction === 'down';
  const sign = p.direction === 'up' || p.direction === 'left' ? -1 : 1;
  const amount = sign * (p.amount ?? (vertical ? window.innerHeight : window.innerWidth) * 0.8);
  const delta = vertical ? { top: amount } : { left: amount };
  if (p.ref !== undefined || p.selector) {
    let el: Element | null = resolveTarget(p);
    while (el && !(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) el = el.parentElement;
    const box = el ?? document.scrollingElement ?? document.documentElement;
    box.scrollBy({ ...delta, behavior: 'instant' });
    return { scroll: { x: Math.round(box.scrollLeft), y: Math.round(box.scrollTop), max_x: box.scrollWidth - box.clientWidth, max_y: box.scrollHeight - box.clientHeight } };
  }
  const before = scrollState();
  window.scrollBy({ ...delta, behavior: 'instant' });
  const after = scrollState();
  if (after.x === before.x && after.y === before.y) mainScroller()?.scrollBy({ ...delta, behavior: 'instant' });
  return { scroll: scrollState() };
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export async function waitFor(p: { text?: string; text_gone?: string; timeout_ms?: number }) {
  const timeout = Math.max(0, Math.min(p.timeout_ms ?? 5000, 60_000));
  const start = performance.now();
  if (!p.text && !p.text_gone) {
    await new Promise((r) => setTimeout(r, Math.min(timeout, 10_000)));
    return { found: null, elapsed_ms: Math.round(performance.now() - start) };
  }
  const want = p.text ? normalize(p.text) : null;
  const gone = p.text_gone ? normalize(p.text_gone) : null;
  for (;;) {
    const body = normalize(document.body?.innerText ?? '');
    if ((!want || body.includes(want)) && (!gone || !body.includes(gone))) {
      return { found: true, elapsed_ms: Math.round(performance.now() - start) };
    }
    if (performance.now() - start >= timeout) return { found: false, elapsed_ms: Math.round(performance.now() - start) };
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ----- basic mode: synthetic events ------------------------------------------

export function fallbackClick(p: TargetParams & { x?: number; y?: number }): { doc: string } {
  let el: Element;
  let x: number;
  let y: number;
  if (p.x !== undefined && p.y !== undefined) {
    const hit = deepElementFromPoint(document, p.x, p.y);
    if (!hit) throw new CommandError(Code.NOT_INTERACTABLE, 'Nothing is at that point.');
    [el, x, y] = [hit, p.x, p.y];
  } else {
    const at = actionPoint(resolveTarget(p));
    [x, y] = [at.x, at.y];
    el = deepElementFromPoint(document, x, y) ?? resolveTarget(p);
  }
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  (el as HTMLElement).click();
  return { doc: docId };
}

export function fallbackType(p: TargetParams & { text: string; clear?: boolean; submit?: boolean }): { doc: string } {
  prepareType(p);
  const el = deepActiveElement() as HTMLInputElement;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    const next = p.clear === false ? el.value + p.text : p.text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: p.text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.ownerDocument.execCommand('insertText', false, p.text);
  }
  if (p.submit) fallbackKey({ keys: 'Enter' });
  return { doc: docId };
}

export function fallbackKey(p: { keys: string }): { doc: string } {
  const el = deepActiveElement() ?? document.body;
  const key = p.keys.split('+').pop() ?? p.keys;
  const init = { key, bubbles: true, cancelable: true, composed: true, ctrlKey: /ctrl|control/i.test(p.keys), shiftKey: /shift/i.test(p.keys), altKey: /alt/i.test(p.keys), metaKey: /meta|cmd/i.test(p.keys) };
  const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (proceed && /^(enter|return)$/i.test(key)) {
    const form = (el as HTMLInputElement).form;
    if (form) form.requestSubmit();
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { doc: docId };
}
