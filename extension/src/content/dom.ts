// DOM inspection helpers. Runs in the extension's isolated world inside the
// page, so page scripts cannot tamper with these functions. Elements may come
// from same-origin iframes (other realms): use tagName checks, not instanceof.

export interface Frame {
  /** Offset of this document's viewport inside the top-level viewport (CSS px). */
  dx: number;
  dy: number;
}

export interface WalkStats {
  crossOriginFrames: number;
}

const PRUNE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'svg', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'SELECT', 'DATALIST', 'OBJECT', 'EMBED']);

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell',
]);

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export function shadowRootOf(el: Element): ShadowRoot | null {
  try {
    return (chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) as ShadowRoot | undefined) ?? el.shadowRoot;
  } catch {
    return el.shadowRoot;
  }
}

/** Document-order walk through light DOM, open+closed shadow roots and same-origin iframes. */
export function* walk(root: ParentNode, frame: Frame, stats: WalkStats): Generator<[Element, Frame]> {
  for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
    yield [el, frame];
    if (PRUNE.has(el.tagName)) continue;
    const shadow = shadowRootOf(el);
    if (shadow) yield* walk(shadow, frame, stats);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      const doc = frameDocument(el);
      if (doc?.documentElement) {
        const r = el.getBoundingClientRect();
        yield* walk(doc, { dx: frame.dx + r.left + el.clientLeft, dy: frame.dy + r.top + el.clientTop }, stats);
      } else if (isRendered(el)) {
        stats.crossOriginFrames++;
      }
      continue;
    }
    yield* walk(el, frame, stats);
  }
}

function frameDocument(el: Element): Document | null {
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

/** Element rect in top-level viewport coordinates (crosses same-origin iframes). */
export function topRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  let win = el.ownerDocument.defaultView;
  while (win && win !== window.top && win.frameElement) {
    const f = win.frameElement;
    const fr = f.getBoundingClientRect();
    x += fr.left + f.clientLeft;
    y += fr.top + f.clientTop;
    win = f.ownerDocument.defaultView;
  }
  return new DOMRect(x, y, r.width, r.height);
}

export function style(el: Element): CSSStyleDeclaration | null {
  return el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
}

export function isRendered(el: Element): boolean {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true, contentVisibilityAuto: true });
  }
  const s = style(el);
  return !!s && s.display !== 'none' && s.visibility !== 'hidden';
}

/** Cheap structural check first; computed `cursor: pointer` only as a last resort. */
export function isInteractive(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'A') return el.hasAttribute('href') || el.hasAttribute('tabindex') || el.hasAttribute('role');
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden';
  if (isEditableHost(el)) return true;
  const role = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick')) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0 && tag !== 'BODY' && tag !== 'HTML' && tag !== 'IFRAME') return true;
  if (tag === 'BODY' || tag === 'HTML' || tag === 'LABEL') return false;
  // div/span with click handlers: approximate by the outermost `cursor: pointer`.
  if (style(el)?.cursor !== 'pointer') return false;
  const parent = el.parentElement;
  return !parent || style(parent)?.cursor !== 'pointer';
}

/** Top-most element of a contenteditable region. */
export function isEditableHost(el: Element): boolean {
  const h = el as HTMLElement;
  return h.isContentEditable === true && !(h.parentElement?.isContentEditable ?? false);
}

export function isTextField(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type.toLowerCase());
  return (el as HTMLElement).isContentEditable === true;
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'clickable';
    case 'BUTTON':
    case 'SUMMARY':
      return 'button';
    case 'SELECT': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'IMG':
      return 'img';
    case 'INPUT':
      switch ((el as HTMLInputElement).type.toLowerCase()) {
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'number':
          return 'spinbutton';
        case 'search':
          return 'searchbox';
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
        case 'file':
        case 'color':
          return 'button';
        default:
          return 'textbox';
      }
  }
  return (el as HTMLElement).isContentEditable ? 'textbox' : 'clickable';
}

function squash(s: string | null | undefined, max = 120): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Text of a <label>, without the text of the control it wraps (e.g. <option>s). */
function labelText(label: Element, control: Element): string {
  let out = '';
  const visit = (n: Node) => {
    if (n === control) return;
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n.nodeType === Node.ELEMENT_NODE && !['SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes((n as Element).tagName)) {
      n.childNodes.forEach(visit);
    }
  };
  visit(label);
  return squash(out);
}

/** A pragmatic subset of the accessible-name algorithm (accname 1.2). */
export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => (root.getElementById?.(id) ?? el.ownerDocument.getElementById(id))?.textContent ?? '')
      .join(' ');
    if (squash(text)) return squash(text);
  }
  const aria = squash(el.getAttribute('aria-label'));
  if (aria) return aria;

  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    const type = (input.type ?? '').toLowerCase();
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) {
      return squash(input.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    }
    if (tag === 'INPUT' && type === 'image') return squash(input.alt || input.value) || 'Submit';
    const labels = input.labels ? [...input.labels].map((l) => labelText(l, el)).filter(Boolean).join(' ') : '';
    return squash(labels) || squash(el.getAttribute('placeholder')) || squash(el.getAttribute('title')) || squash(el.getAttribute('name'));
  }
  if ((el as HTMLElement).isContentEditable) {
    return squash(el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || el.getAttribute('title'));
  }
  if (tag === 'IMG') return squash((el as HTMLImageElement).alt || el.getAttribute('title'));
  const text = squash((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;
  const title = squash(el.getAttribute('title'));
  if (title) return title;
  const icon = el.querySelector('img[alt], [aria-label], svg title');
  return squash(icon?.getAttribute('alt') ?? icon?.getAttribute('aria-label') ?? icon?.textContent);
}

const SENSITIVE_AUTOCOMPLETE = /\b(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|current-password|new-password|one-time-code)\b/i;
const SENSITIVE_NAME = /(^|[^a-z])(cvv2?|cvc2?|csc|card.?num(ber)?|cc.?num(ber)?|security.?code|otp|one.?time.?(code|password))([^a-z]|$)/i;

// Labels people actually see, in English and Bangla.
const SENSITIVE_LABEL = /\b(password|passcode|pass code|cvv2?|cvc2?|security code|card number|card no|one[- ]time (code|password)|otp|verification code)\b|পাসওয়ার্ড|পাসকোড|ওটিপি|ভেরিফিকেশন কোড|যাচাইকরণ কোড|কার্ড নম্বর|কার্ড নাম্বার|সিভিভি/i;

/** Password, one-time-code and payment-card fields: never typed into, never read. */
export function isSensitive(el: Element): boolean {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  const input = el as HTMLInputElement;
  if (input.type?.toLowerCase() === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
  if (SENSITIVE_NAME.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''}`)) return true;
  return SENSITIVE_LABEL.test(accessibleName(el));
}

export function isDisabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    (el.closest('fieldset[disabled]') !== null && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName))
  );
}

export function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  for (;;) {
    const shadow = a ? shadowRootOf(a) : null;
    if (shadow?.activeElement) {
      a = shadow.activeElement;
      continue;
    }
    if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
      const doc = frameDocument(a);
      if (doc?.activeElement && doc.activeElement !== doc.body) {
        a = doc.activeElement;
        continue;
      }
    }
    return a;
  }
}

/** Value as an agent may see it; sensitive fields are redacted. */
export function valueOf(el: Element): string | undefined {
  const tag = el.tagName;
  let value: string | undefined;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = input.type.toLowerCase();
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(type)) return undefined;
    value = type === 'file' ? [...(input.files ?? [])].map((f) => f.name).join(', ') : input.value;
  } else if (tag === 'TEXTAREA') {
    value = (el as HTMLTextAreaElement).value;
  } else if (tag === 'SELECT') {
    value = [...(el as HTMLSelectElement).selectedOptions].map((o) => squash(o.label || o.text, 60)).join(', ');
  } else if ((el as HTMLElement).isContentEditable) {
    value = (el as HTMLElement).innerText;
  } else {
    value = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? undefined;
  }
  if (value === undefined) return undefined;
  if (isSensitive(el)) return value ? '(hidden)' : '';
  return squash(value, 200);
}

export function statesOf(el: Element): string[] {
  const s: string[] = [];
  const input = el as HTMLInputElement;
  const type = el.tagName === 'INPUT' ? input.type.toLowerCase() : '';
  if (type === 'checkbox' || type === 'radio') {
    s.push(input.checked ? 'checked' : 'unchecked');
  } else {
    const checked = el.getAttribute('aria-checked');
    if (checked === 'true') s.push('checked');
    else if (checked === 'false') s.push('unchecked');
    else if (checked === 'mixed') s.push('mixed');
  }
  if (isDisabled(el)) s.push('disabled');
  if ((input.readOnly && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) || el.getAttribute('aria-readonly') === 'true') s.push('readonly');
  if (input.required === true || el.getAttribute('aria-required') === 'true') s.push('required');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') s.push(`expanded=${expanded}`);
  if (el.getAttribute('aria-selected') === 'true') s.push('selected');
  if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
  const current = el.getAttribute('aria-current');
  if (current && current !== 'false') s.push('current');
  if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
  if (deepActiveElement() === el) s.push('focused');
  if (el.tagName === 'A' && (el as HTMLAnchorElement).target === '_blank') s.push('opens-new-tab');
  if (type === 'file') s.push('file-upload');
  if (isSensitive(el)) s.push(type === 'password' ? 'password' : 'sensitive');
  return s;
}

/** Hit test that descends into shadow roots and same-origin iframes. */
export function deepElementFromPoint(doc: Document | ShadowRoot, x: number, y: number): Element | null {
  let el = doc.elementFromPoint(x, y);
  for (let guard = 0; el && guard < 32; guard++) {
    const shadow = shadowRootOf(el);
    const inner = shadow?.elementFromPoint(x, y);
    if (inner && inner !== el) {
      el = inner;
      continue;
    }
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      const fdoc = frameDocument(el);
      if (fdoc) {
        const r = el.getBoundingClientRect();
        return deepElementFromPoint(fdoc, x - r.left - el.clientLeft, y - r.top - el.clientTop) ?? el;
      }
    }
    return el;
  }
  return el;
}

/** `ancestor` contains `node`, crossing shadow boundaries. */
export function composedContains(ancestor: Element, node: Node | null): boolean {
  for (let n = node; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : (n as Node & { host?: Element }).host ?? null)) {
    if (n === ancestor) return true;
  }
  return false;
}

/** Short human description for error messages, e.g. `dialog "Cookie settings"`. */
export function describe(el: Element | null): string {
  if (!el) return 'nothing';
  const container = el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]') ?? el;
  const name = accessibleName(container) || squash((container as HTMLElement).innerText, 60);
  const id = container.id ? `#${container.id}` : '';
  const cls = typeof container.className === 'string' && container.className.trim() ? `.${container.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${roleOf(container)} <${container.tagName.toLowerCase()}${id}${cls}>${name ? ` "${squash(name, 60)}"` : ''}`;
}

export function labelFor(el: Element): Element | null {
  const labels = (el as HTMLInputElement).labels;
  return labels && labels.length > 0 ? labels[0]! : null;
}
