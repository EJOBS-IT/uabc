// Element refs: small integers that stay stable for the lifetime of this
// document. `docId` identifies the document, so refs from a previous page can
// be rejected (STALE_REF) instead of hitting whatever now has the same number.

import { CommandError, Code } from '../shared/protocol';

export const docId = crypto.randomUUID().slice(0, 8);

let nextRef = 1;
const byRef = new Map<string, WeakRef<Element>>();
const byElement = new WeakMap<Element, string>();

export function refFor(el: Element): string {
  let ref = byElement.get(el);
  if (!ref) {
    ref = String(nextRef++);
    byElement.set(el, ref);
    byRef.set(ref, new WeakRef(el));
  }
  return ref;
}

export interface TargetParams {
  ref?: string | number;
  selector?: string;
  expect_doc?: string;
}

export function resolveTarget(p: TargetParams): Element {
  if (p.ref !== undefined && p.ref !== null) {
    const ref = String(p.ref).replace(/[[\]\s]/g, '');
    if (p.expect_doc && p.expect_doc !== docId) {
      throw new CommandError(
        Code.STALE_REF,
        `Ref [${ref}] belongs to a page that is no longer loaded in this tab.`,
        'Call browser_get_state to get fresh refs for the current page.',
      );
    }
    const el = byRef.get(ref)?.deref();
    if (!el || !el.isConnected) {
      throw new CommandError(
        Code.REF_NOT_FOUND,
        `Element [${ref}] is no longer on the page.`,
        'The page changed. Call browser_get_state again and use the new refs.',
      );
    }
    return el;
  }
  if (p.selector) {
    let el: Element | null;
    try {
      el = document.querySelector(p.selector);
    } catch {
      throw new CommandError(Code.INVALID_PARAMS, `"${p.selector}" is not a valid CSS selector.`);
    }
    if (!el) throw new CommandError(Code.REF_NOT_FOUND, `No element matches the selector "${p.selector}".`);
    return el;
  }
  throw new CommandError(Code.INVALID_PARAMS, 'Specify the element with `ref` or `selector`.');
}
