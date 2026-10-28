// Trusted input and screenshots through the Chrome DevTools Protocol
// (chrome.debugger). Events dispatched this way have isTrusted=true, carry user
// activation, and Input.insertText types any Unicode (Bangla included).
//
// While attached, Chrome shows "UABC started debugging this browser". If the
// user clicks Cancel on that bar we treat it as a stop request (pause).

import { type Chord, MODIFIER_KEYS, type Modifier } from '../shared/keys';
import { CommandError, Code } from '../shared/protocol';

const attached = new Set<number>();
let userCancelled: (tabId: number) => void = () => {};
/** Set while AI control is paused: nothing may attach or send, so in-flight actions abort. */
let blocked: CommandError | null = null;

export function block(reason: CommandError | null): void {
  blocked = reason;
}

export function onUserCancel(fn: (tabId: number) => void): void {
  userCancelled = fn;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  if (reason === 'canceled_by_user') userCancelled(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

async function attach(tabId: number): Promise<void> {
  if (blocked) throw blocked;
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (!/already attached/i.test(msg)) {
      throw new CommandError(
        Code.CDP_UNAVAILABLE,
        `Trusted input is not available on this tab (${msg}).`,
        'An administrator policy or another debugger may block it. The user can switch UABC to Basic input mode in its settings.',
      );
    }
  }
  if (blocked) {
    // Paused while attaching: undo it instead of staying attached while paused.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw blocked;
  }
  attached.add(tabId);
  // Lets background tabs behave as focused (focus/blur-sensitive widgets).
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

export async function detachAll(): Promise<void> {
  const ids = [...attached];
  attached.clear();
  await Promise.all(ids.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
}

export async function send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  await attach(tabId);
  if (blocked) throw blocked;
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (e) {
    throw new CommandError(Code.CDP_UNAVAILABLE, `${method} failed: ${(e as Error).message ?? e}`);
  }
}

const BUTTONS = { left: 1, right: 2, middle: 4 } as const;
export type MouseButton = keyof typeof BUTTONS;

export async function click(tabId: number, x: number, y: number, button: MouseButton = 'left', clickCount = 1, modifiers = 0): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, button: 'none' });
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers, button, buttons: BUTTONS[button], clickCount: i });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers, button, buttons: 0, clickCount: i });
  }
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await send(tabId, 'Input.insertText', { text });
}

const MASK: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export async function press(tabId: number, chord: Chord): Promise<void> {
  let mask = 0;
  for (const m of chord.modifiers) {
    mask |= MASK[m];
    const k = MODIFIER_KEYS[m];
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, location: k.location, modifiers: mask });
  }
  const k = chord.key;
  const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, location: k.location ?? 0, modifiers: chord.mask };
  await send(tabId, 'Input.dispatchKeyEvent', {
    ...common,
    type: k.text ? 'keyDown' : 'rawKeyDown',
    text: k.text,
    unmodifiedText: k.text,
    ...(chord.commands.length ? { commands: chord.commands } : {}),
  });
  await send(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  for (const m of [...chord.modifiers].reverse()) {
    mask &= ~MASK[m];
    const mk = MODIFIER_KEYS[m];
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.keyCode, location: mk.location, modifiers: mask });
  }
}

interface LayoutMetrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
}

export async function screenshot(
  tabId: number,
  opts: { format: 'jpeg' | 'png'; quality: number; fullPage: boolean; dpr: number },
): Promise<{ data: string; width: number; height: number }> {
  const m = await send<LayoutMetrics>(tabId, 'Page.getLayoutMetrics');
  const vv = m.cssVisualViewport;
  // Normalize to CSS pixels so coordinates in the image match click coordinates.
  const scale = 1 / Math.max(opts.dpr || 1, 1);
  const clip = opts.fullPage
    ? { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.min(Math.ceil(m.cssContentSize.height), 8000), scale }
    : { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale };
  const shot = send<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format: opts.format,
    ...(opts.format === 'jpeg' ? { quality: opts.quality } : {}),
    clip,
    captureBeyondViewport: opts.fullPage,
    optimizeForSpeed: true,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new CommandError(Code.TIMEOUT, 'The screenshot did not complete (is the browser window minimized?).')), 15_000),
  );
  const { data } = await Promise.race([shot, timeout]);
  return { data, width: Math.round(clip.width), height: Math.round(clip.height) };
}
