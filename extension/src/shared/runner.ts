// The browser_* tools as the built-in assistant runs them: a TypeScript port of
// the tool layer in host/src/mcp.rs (argument checks, defaults and limits,
// stale-ref tracking, result formatting). A model gets the same behaviour in
// the side panel as behind MCP. Keep both in sync.

import * as format from './format';
import { Code, type ErrorBody, toErrorBody } from './protocol';
import { TOOLS, type ToolSpec } from './tools';

/** Long enough for the user to answer a site prompt (120 s) on top of the action itself. */
export const COMMAND_TIMEOUT_MS = 150_000;
const QUICK_TIMEOUT_MS = 10_000;

/** Sends extension commands (docs/protocol.md); rejects with an ErrorBody. */
export interface Backend {
  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  /** Changes whenever the extension session was re-created, which forgets the current tab. */
  readonly generation: number;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
  image?: { mime: string; data: string };
}

type Args = Record<string, unknown>;
type V = Record<string, any>;

class ToolError extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.message);
  }
}

const invalid = (message: string) => new ToolError({ code: Code.INVALID_PARAMS, message });

/** Finds a tool by name; a name that differs only in letter case still matches. */
export function resolveTool(name: string, tools: ToolSpec[] = TOOLS): ToolSpec | undefined {
  return tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
}

// ----- argument readers ---------------------------------------------------------
// Models (small local ones especially) send "12" for 12 or "true" for true;
// both are accepted. Anything else of the wrong type is an INVALID_PARAMS error.

function has(a: Args, key: string): boolean {
  return a[key] !== undefined && a[key] !== null;
}

function str(a: Args, key: string): string | undefined {
  if (!has(a, key)) return undefined;
  const v = a[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw invalid(`\`${key}\` must be a string.`);
}

function num(a: Args, key: string): number | undefined {
  if (!has(a, key)) return undefined;
  const v = a[key];
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw invalid(`\`${key}\` must be a number.`);
  return n;
}

function int(a: Args, key: string): number | undefined {
  const n = num(a, key);
  if (n !== undefined && !Number.isInteger(n)) throw invalid(`\`${key}\` must be a whole number.`);
  return n;
}

function bool(a: Args, key: string): boolean | undefined {
  if (!has(a, key)) return undefined;
  const v = a[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  throw invalid(`\`${key}\` must be true or false.`);
}

function oneOf<T extends string>(a: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = str(a, key);
  if (v === undefined) return undefined;
  const found = allowed.find((x) => x === v.trim().toLowerCase());
  if (!found) throw invalid(`\`${key}\` must be one of: ${allowed.join(', ')}.`);
  return found;
}

function strings(a: Args, key: string): string[] | undefined {
  if (!has(a, key)) return undefined;
  const v = a[key];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw invalid(`\`${key}\` must be a list of strings.`);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** An element ref from browser_get_state: 12, "12", "[12]" and " [12] " all mean 12. */
export function normalizeRef(raw: unknown): string {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === 'string') return raw.trim().replace(/^\[+/, '').replace(/\]+$/, '').trim();
  throw invalid('`ref` must be an element ref such as "12".');
}

function stripNulls(p: Args): Args {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null));
}

// ----- the runner ------------------------------------------------------------------

export class ToolRunner {
  /** What this session last saw, so ref-based actions can be checked for staleness. */
  currentTab?: number;
  readonly docs = new Map<number, string>();
  private generation?: number;

  constructor(
    private readonly backend: Backend,
    /** First line of browser_status, e.g. "Connected to Chrome 153 through the built-in UABC assistant." */
    private readonly headline: () => string,
  ) {}

  async run(name: string, args: unknown): Promise<ToolOutput> {
    const tool = resolveTool(name);
    try {
      if (!tool) {
        throw new ToolError({
          code: Code.UNKNOWN_METHOD,
          message: `There is no tool named "${name}". The tools are: ${TOOLS.map((t) => t.name).join(', ')}.`,
        });
      }
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Args) : {};
      return await this.dispatch(tool.name, a);
    } catch (e) {
      return { text: format.error(e instanceof ToolError ? e.body : toErrorBody(e)), isError: true };
    }
  }

  private async dispatch(name: string, a: Args): Promise<ToolOutput> {
    const tabId = int(a, 'tab_id');
    switch (name) {
      case 'browser_status':
        return ok(format.status(this.headline(), await this.call('browser.status', {}, QUICK_TIMEOUT_MS)));

      case 'browser_tabs': {
        const action = oneOf(a, 'action', ['list', 'new', 'select', 'close'] as const);
        let v: V;
        switch (action) {
          case 'list':
            v = await this.call('tabs.list', {}, QUICK_TIMEOUT_MS);
            break;
          case 'new':
            v = await this.call('tabs.open', { url: str(a, 'url'), background: bool(a, 'background') ?? false }, COMMAND_TIMEOUT_MS);
            break;
          case 'select':
            if (tabId === undefined) throw invalid('`tab_id` is required for action=select.');
            v = await this.call('tabs.select', { tab_id: tabId }, QUICK_TIMEOUT_MS);
            break;
          case 'close':
            v = await this.call('tabs.close', { tab_id: tabId }, QUICK_TIMEOUT_MS);
            break;
          default:
            throw invalid('`action` is required: list, new, select or close.');
        }
        return ok(format.tabs(v));
      }

      case 'browser_navigate': {
        const url = str(a, 'url');
        const history = oneOf(a, 'history', ['back', 'forward', 'reload'] as const);
        if ((url === undefined) === (history === undefined)) throw invalid('Pass exactly one of `url` or `history`.');
        const params = url !== undefined ? { url, tab_id: tabId } : { history, tab_id: tabId };
        return ok(format.navigated(await this.call('page.navigate', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_get_state': {
        const params = {
          mode: oneOf(a, 'mode', ['viewport', 'full'] as const) ?? 'viewport',
          include_text: bool(a, 'include_text') ?? false,
          max_elements: clamp(int(a, 'max_elements') ?? 150, 1, 1000),
          max_text: clamp(int(a, 'max_text') ?? 6000, 100, 100_000),
          tab_id: tabId,
        };
        return ok(format.snapshot(await this.call('page.snapshot', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_screenshot': {
        const params = {
          marks: bool(a, 'marks') ?? true,
          full_page: bool(a, 'full_page') ?? false,
          format: oneOf(a, 'format', ['jpeg', 'png'] as const) ?? 'jpeg',
          quality: clamp(int(a, 'quality') ?? 70, 1, 100),
          tab_id: tabId,
        };
        const v = await this.call('page.screenshot', params, COMMAND_TIMEOUT_MS);
        const image = { mime: typeof v.mime === 'string' ? v.mime : 'image/jpeg', data: typeof v.data === 'string' ? v.data : '' };
        return { text: format.screenshotCaption(v), isError: false, image };
      }

      case 'browser_click': {
        const x = num(a, 'x');
        const y = num(a, 'y');
        if ((x === undefined) !== (y === undefined)) throw invalid('Pass both `x` and `y`.');
        const target = this.targetParams(a, tabId);
        let params: Args;
        if (x !== undefined && target === null) params = { x, y, tab_id: tabId };
        else if (x === undefined && target !== null) params = target;
        else throw invalid('Pass exactly one of `ref`, `selector`, or `x`+`y`.');
        params.button = oneOf(a, 'button', ['left', 'right', 'middle'] as const) ?? 'left';
        params.click_count = clamp(int(a, 'click_count') ?? 1, 1, 3);
        params.modifiers = strings(a, 'modifiers') ?? [];
        return ok(format.acted('Clicked', await this.call('input.click', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_type': {
        const params = this.targetParams(a, tabId);
        if (!params) throw invalid('Pass `ref` or `selector`.');
        const text = str(a, 'text');
        if (text === undefined) throw invalid('`text` is required.');
        params.text = text;
        params.clear = bool(a, 'clear') ?? true;
        params.submit = bool(a, 'submit') ?? false;
        return ok(format.acted('Typed', await this.call('input.type', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_press_key': {
        const keys = str(a, 'keys');
        if (!keys) throw invalid('`keys` is required, e.g. "Enter" or "Control+A".');
        return ok(format.acted('Pressed', await this.call('input.key', { keys, tab_id: tabId }, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_scroll': {
        const direction = oneOf(a, 'direction', ['up', 'down', 'left', 'right'] as const);
        if (!direction) throw invalid('`direction` is required: up, down, left or right.');
        const params: Args = { direction, amount: num(a, 'amount'), tab_id: tabId };
        if (has(a, 'ref')) {
          const p = this.refParams(a.ref, tabId);
          params.ref = p.ref;
          params.expect_doc = p.expect_doc;
        }
        return ok(format.scrolled(await this.call('page.scroll', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_select_option': {
        const params = this.targetParams(a, tabId);
        if (!params) throw invalid('Pass `ref` or `selector`.');
        const values = strings(a, 'values');
        if (!values) throw invalid('`values` is required: the option labels or values to choose.');
        params.values = values;
        return ok(format.selected(await this.call('input.select', params, COMMAND_TIMEOUT_MS)));
      }

      case 'browser_wait_for': {
        const text = str(a, 'text');
        const textGone = str(a, 'text_gone');
        const cap = text !== undefined || textGone !== undefined ? 60_000 : 10_000;
        const timeoutMs = clamp(int(a, 'timeout_ms') ?? 5_000, 0, cap);
        const params = { text, text_gone: textGone, timeout_ms: timeoutMs, tab_id: tabId };
        return ok(format.waited(await this.call('page.wait_for', params, COMMAND_TIMEOUT_MS + timeoutMs)));
      }

      default:
        throw new ToolError({ code: Code.UNKNOWN_METHOD, message: `Tool ${name} is not implemented.` });
    }
  }

  private async call(method: string, params: Args, timeoutMs: number): Promise<V> {
    await this.resync();
    const result = (await this.backend.call(method, stripNulls(params), timeoutMs)) as V;
    this.observe(method, result ?? {});
    return result ?? {};
  }

  /**
   * A new extension session has no current tab: re-select the one this
   * conversation was working in (tab ids survive service worker restarts).
   */
  private async resync(): Promise<void> {
    if (this.generation === this.backend.generation) return;
    this.generation = this.backend.generation;
    this.docs.clear();
    const previous = this.currentTab;
    this.currentTab = undefined;
    if (previous === undefined) return;
    try {
      await this.backend.call('tabs.select', { tab_id: previous }, QUICK_TIMEOUT_MS);
      this.currentTab = previous;
    } catch {
      // the tab is gone or no longer shared; the next tool call reports NO_TAB
    }
  }

  /** Learns the current tab and document ids from every result. */
  observe(method: string, v: V): void {
    const tabFromOpen = v.tab?.id;
    if (typeof tabFromOpen === 'number') this.currentTab = tabFromOpen;
    if (typeof v.tab_id === 'number') {
      const id = v.tab_id;
      this.currentTab = id;
      if (typeof v.doc === 'string') this.docs.set(id, v.doc);
      // A navigation without a fresh snapshot invalidates the old one.
      else if (v.navigated === true || method === 'page.navigate') this.docs.delete(id);
    }
    if (typeof v.closed === 'number') {
      this.docs.delete(v.closed);
      if (this.currentTab === v.closed) this.currentTab = undefined;
    }
  }

  /** `{ref, expect_doc, tab_id}`, or STALE_REF if no snapshot of that tab was taken yet. */
  refParams(raw: unknown, tabId: number | undefined): Args {
    const ref = normalizeRef(raw);
    const tab = tabId ?? this.currentTab;
    const doc = tab === undefined ? undefined : this.docs.get(tab);
    if (doc === undefined) {
      throw new ToolError({
        code: Code.STALE_REF,
        message: 'There is no up-to-date element list for this tab, so the ref cannot be trusted.',
        hint: 'Call browser_get_state (or browser_screenshot with marks) first, then use the refs it returns.',
      });
    }
    return { ref, expect_doc: doc, tab_id: tabId };
  }

  private targetParams(a: Args, tabId: number | undefined): Args | null {
    const hasRef = has(a, 'ref');
    const selector = str(a, 'selector');
    if (hasRef && selector !== undefined) throw invalid('Pass either `ref` or `selector`, not both.');
    if (hasRef) return this.refParams(a.ref, tabId);
    if (selector !== undefined) return { selector, tab_id: tabId };
    return null;
  }
}

function ok(text: string): ToolOutput {
  return { text, isError: false };
}
