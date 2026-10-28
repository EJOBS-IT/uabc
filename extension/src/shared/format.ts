// LLM-facing text for tool results: a TypeScript port of host/src/format.rs so
// the built-in assistant sees exactly what MCP clients see. Keep both in sync.
//
// Everything that comes from a web page (URLs, titles, element names, field
// values, option labels, page text) is placed inside an
// <untrusted-web-content> fence; UABC's own words (status lines, hints) stay
// outside. Page text never contains '<' or '>' (escaped to ‹ ›), so no variant
// of the fence tag can be forged.

import type { ErrorBody } from './protocol';

type V = Record<string, unknown> & { [k: string]: any };

const FENCE = 'untrusted-web-content';
const PAGE_TEXT_CODES = new Set(['OBSCURED', 'NOT_INTERACTABLE', 'SENSITIVE_FIELD', 'NO_SUCH_OPTION']);

export function clean(s: string): string {
  return s.replaceAll('<', '‹').replaceAll('>', '›').replace(/[\u0000\r]/g, '');
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function oneLine(s: unknown, max: number): string {
  return truncate(clean(String(s ?? '')).split(/\s+/).filter(Boolean).join(' '), max);
}

function fence(attr: string, body: string): string {
  return `<${FENCE} ${attr}>\n${body.trimEnd()}\n</${FENCE}>`;
}

export function originOf(url: string): string {
  const [scheme, rest] = url.includes('://') ? [url.slice(0, url.indexOf('://')), url.slice(url.indexOf('://') + 3)] : ['', url];
  const host = rest.split(/[/?#]/)[0] ?? '';
  return clean(scheme ? `${scheme}://${host}` : host).replace(/["<> ‹›]/g, '');
}

const originAttr = (url: string) => `origin="${originOf(url)}"`;
const str = (v: V, key: string): string => (typeof v?.[key] === 'string' ? (v[key] as string) : '');

function tabLine(tab: V): string {
  let line = `tab ${tab.id} · ${oneLine(str(tab, 'url'), 120)}`;
  if (tab.approved === false) {
    line += ' · (site not approved yet)';
  } else {
    const title = oneLine(str(tab, 'title'), 80);
    if (title) line += ` · "${title}"`;
  }
  if (tab.current === true) line += '  ← current';
  return line;
}

function tabList(tabs: V[]): string {
  return fence('source="tab addresses and titles"', tabs.map((t) => `  ${tabLine(t)}`).join('\n'));
}

function pageBlock(url: string, title: string): string {
  let body = `URL: ${oneLine(url, 300)}`;
  const t = oneLine(title, 150);
  if (t) body += `\nTitle: ${t}`;
  return fence(originAttr(url), body);
}

/** `headline` is written by the caller, e.g. "Connected to Chrome 153 (built-in assistant)." */
export function status(headline: string, v: V): string {
  let out = `${headline}\n`;
  if (v.paused === true) out += 'AI control is PAUSED by the user. Ask them to resume it from the UABC toolbar button.\n';
  const mode =
    ({ ask: 'the user is asked before you can use a new website', listed: 'only pre-approved websites are available; others are refused', all: 'all websites are allowed (developer mode)' } as Record<string, string>)[
      str(v, 'mode')
    ] ?? 'unknown';
  out += `Site access: ${mode}.\n`;
  out += `Input mode: ${str(v, 'input_mode') === 'basic' ? 'basic (synthetic events)' : 'trusted (DevTools protocol)'}.\n`;
  const tabs: V[] = Array.isArray(v.tabs) ? v.tabs : [];
  out += tabs.length ? `Shared tabs (${tabs.length}):\n${tabList(tabs)}\n` : 'Shared tabs: none. Open one with browser_tabs(action="new", url=…).\n';
  const grants: string[] = (Array.isArray(v.grants) ? v.grants : []).filter((g: unknown): g is string => typeof g === 'string').map(originOf);
  if (grants.length) out += `Approved websites: ${grants.join(', ')}\n`;
  return out;
}

export function tabs(v: V): string {
  if (typeof v.closed === 'number') return `Closed tab ${v.closed}.`;
  if (v.tab && typeof v.tab === 'object') return `Now working in tab ${v.tab.id}:\n${fence('source="tab address and title"', tabLine(v.tab))}`;
  const list: V[] = Array.isArray(v.tabs) ? v.tabs : [];
  if (!list.length) {
    return 'No tabs are shared with you. Open one with browser_tabs(action="new", url=…), or ask the user to drag a tab into the UABC tab group.';
  }
  return `${list.length} shared tab(s):\n${tabList(list)}`;
}

export function navigated(v: V): string {
  const loading = str(v, 'status') === 'loading';
  return `Tab ${v.tab_id} ${loading ? 'is still loading' : 'finished loading'}. Call browser_get_state to see the page.\n${pageBlock(str(v, 'url'), str(v, 'title'))}`;
}

function elementLine(el: V): string {
  let line = `[${oneLine(el.ref ?? '?', 12)}] ${oneLine(el.role, 30)}`;
  const name = oneLine(el.name, 100);
  if (name) line += ` "${name.replaceAll('"', "'")}"`;
  if (typeof el.value === 'string') line += ` value="${oneLine(el.value, 80).replaceAll('"', "'")}"`;
  for (const s of Array.isArray(el.states) ? el.states : []) if (typeof s === 'string') line += ` ${oneLine(s, 30)}`;
  if (typeof el.href === 'string') line += ` → ${oneLine(el.href, 80)}`;
  if (Array.isArray(el.options)) {
    const shown = el.options.filter((o: unknown): o is string => typeof o === 'string').map((o: string) => oneLine(o, 40));
    const total = typeof el.n_options === 'number' ? el.n_options : shown.length;
    line += ` options: ${shown.join(' | ')}${total > shown.length ? `, … (${total} total)` : ''}`;
  }
  if (typeof el.offscreen === 'string') line += ` (offscreen ${oneLine(el.offscreen, 10)})`;
  return line;
}

export function snapshot(v: V): string {
  const url = str(v, 'url');
  const sy = Number(v.scroll?.y ?? 0);
  const maxY = Number(v.scroll?.max_y ?? 0);
  const position =
    maxY <= 0 ? 'the whole page fits on screen' : sy <= 0 ? `at the top, ${maxY.toFixed(0)}px more below` : sy >= maxY - 1 ? 'at the bottom' : `scrolled ${sy.toFixed(0)} of ${maxY.toFixed(0)}px`;
  const head = `Tab ${v.tab_id} · viewport ${Number(v.viewport?.w ?? 0)}×${Number(v.viewport?.h ?? 0)} · ${position}\n`;
  let body = `URL: ${oneLine(url, 300)}\nTitle: ${oneLine(str(v, 'title'), 150)}\n`;
  const elements: V[] = Array.isArray(v.elements) ? v.elements : [];
  if (!elements.length) body += '(no interactive elements in view)\n';
  for (const el of elements) body += `${elementLine(el)}\n`;
  const above = Number(v.counts?.above ?? 0);
  const below = Number(v.counts?.below ?? 0);
  if (above > 0) body += `… ${above} more element(s) above (scroll up)\n`;
  if (below > 0) body += `… ${below} more element(s) below (scroll down)\n`;
  if (v.counts?.truncated === true) body += '… list truncated; raise max_elements or scroll\n';
  for (const note of Array.isArray(v.notes) ? v.notes : []) if (typeof note === 'string') body += `Note: ${clean(note)}\n`;
  if (typeof v.text === 'string') {
    body += `\nVisible text:\n${clean(v.text)}`;
    if (v.text_truncated === true) body += '\n… (text truncated; raise max_text)';
  }
  return head + fence(originAttr(url), body);
}

export function screenshotCaption(v: V): string {
  const marks = Number(v.marks ?? 0);
  return `Screenshot of tab ${v.tab_id}${marks > 0 ? ` with ${marks} numbered element badges (the numbers are refs for browser_click / browser_type)` : ''}.`;
}

export function acted(verb: string, v: V): string {
  let out = `${verb}.`;
  const nav = v.navigated === true;
  if (nav) out += ' The tab navigated to a new page; old refs are invalid, call browser_get_state.';
  if (typeof v.note === 'string') out += ` Note: ${clean(v.note)}`;
  const quoted: string[] = [];
  if (nav) {
    quoted.push(`URL: ${oneLine(str(v, 'url'), 300)}`);
    const title = oneLine(str(v, 'title'), 150);
    if (title) quoted.push(`Title: ${title}`);
  }
  if (typeof v.value === 'string') quoted.push(`Field value now: "${oneLine(v.value, 200).replaceAll('"', "'")}"`);
  if (quoted.length) out += `\n${fence(originAttr(str(v, 'url')), quoted.join('\n'))}`;
  return out;
}

export function selected(v: V): string {
  const labels = (Array.isArray(v.selected) ? v.selected : []).filter((s: unknown): s is string => typeof s === 'string').map((s: string) => oneLine(s, 60));
  return `Selected:\n${fence('source="option labels"', labels.join(' | '))}`;
}

export function scrolled(v: V): string {
  const s = v.scroll ?? {};
  const [x, y, mx, my] = [s.x, s.y, s.max_x, s.max_y].map((n) => Number(n ?? 0));
  let out = `Scrolled to x=${x!.toFixed(0)}, y=${y!.toFixed(0)} (max ${mx!.toFixed(0)}, ${my!.toFixed(0)}).`;
  if (my! > 0 && y! >= my! - 1) out += ' Reached the bottom.';
  else if (y! <= 0) out += ' At the top.';
  return out;
}

export function waited(v: V): string {
  const elapsed = Number(v.elapsed_ms ?? 0);
  if (v.found === true) return `Condition met after ${elapsed} ms.`;
  if (v.found === false) return `Condition NOT met within ${elapsed} ms.`;
  return `Waited ${elapsed} ms.`;
}

export function error(e: ErrorBody): string {
  const code = oneLine(e.code, 40);
  let out =
    e.page_text === true || PAGE_TEXT_CODES.has(code)
      ? `Error ${code} (details quote the page):\n${fence('source="page elements"', oneLine(e.message, 600))}`
      : `Error ${code}: ${oneLine(e.message, 600)}`;
  if (e.hint) out += `\nHint: ${oneLine(e.hint, 400)}`;
  return out;
}
