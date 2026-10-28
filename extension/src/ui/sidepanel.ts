// The built-in assistant: a chat in Chrome's side panel that drives the
// browser through the same tools, gates and kill switch as MCP clients.

import { type Conversation, newConversation, runTurn } from '../assistant/agent';
import { WorkerBackend } from '../assistant/backend';
import { currentSelection, loadConfig, onConfigChange, updateConfig, usable } from '../assistant/config';
import type { AssistantConfig, ToolCall } from '../assistant/types';
import { browserInfo } from '../shared/browser';
import { ToolRunner, type ToolOutput } from '../shared/runner';
import { type Status, h, ui } from './common';
import { renderMarkdown } from './markdown';

const browser = browserInfo();
const backend = new WorkerBackend();
const runner = new ToolRunner(
  backend,
  () => `Connected to ${browser.name} ${browser.version} through the built-in UABC assistant (extension ${chrome.runtime.getManifest().version}).`,
);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSelect = $<HTMLSelectElement>('model');
const banner = $<HTMLDivElement>('banner');
const log = $<HTMLDivElement>('log');
const input = $<HTMLTextAreaElement>('input');
const sendButton = $<HTMLButtonElement>('send');
const usageLine = $<HTMLDivElement>('usage');

let config: AssistantConfig = { providers: [], maxSteps: 40, screenshots: true };
let conversation: Conversation | null = null;
let running: AbortController | null = null;
let status: Status | null = null;

// ----- chat log ----------------------------------------------------------------

function scrollToEnd(): void {
  log.scrollTop = log.scrollHeight;
}

const thinking = h('div', { class: 'thinking', role: 'status' }, h('span', {}), h('span', {}), h('span', {}), h('span', { class: 'sr-only' }, 'Thinking'));

function add(node: Node): void {
  log.querySelector('.empty')?.remove();
  if (thinking.isConnected) log.insertBefore(node, thinking);
  else log.append(node);
  scrollToEnd();
}

function addNotice(level: 'info' | 'warn' | 'error', text: string): void {
  add(h('div', { class: `line ${level}`, role: level === 'error' ? 'alert' : 'status' }, text));
}

const short = (v: unknown, n = 60) => {
  const s = String(v ?? '').replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** One line per tool call, in the user's terms. Arguments come from the model: text only. */
function describe(call: ToolCall): string {
  const a = call.args as Record<string, any>;
  const target = a.ref !== undefined ? `element [${short(a.ref, 8)}]` : a.selector ? `"${short(a.selector, 40)}"` : a.x !== undefined ? `point (${a.x}, ${a.y})` : 'element';
  switch (call.name) {
    case 'browser_status':
      return 'Checked the browser';
    case 'browser_tabs':
      return a.action === 'new' ? `Opened ${short(a.url ?? 'a new tab')}` : a.action === 'select' ? `Switched to tab ${short(a.tab_id, 12)}` : a.action === 'close' ? 'Closed a tab' : 'Listed tabs';
    case 'browser_navigate':
      return a.url ? `Went to ${short(a.url)}` : `Went ${short(a.history, 10)}`;
    case 'browser_get_state':
      return a.include_text ? 'Read the page and its text' : 'Read the page';
    case 'browser_screenshot':
      return 'Took a screenshot';
    case 'browser_click':
      return `Clicked ${target}`;
    case 'browser_type':
      return `Typed "${short(a.text, 40)}" into ${target}`;
    case 'browser_press_key':
      return `Pressed ${short(a.keys, 30)}`;
    case 'browser_scroll':
      return `Scrolled ${short(a.direction, 10)}`;
    case 'browser_select_option':
      return `Chose ${short(Array.isArray(a.values) ? a.values.join(', ') : a.values, 40)} in ${target}`;
    case 'browser_wait_for':
      return a.text ? `Waited for "${short(a.text, 40)}"` : a.text_gone ? `Waited for "${short(a.text_gone, 40)}" to go away` : 'Waited';
    default:
      return short(call.name, 40);
  }
}

function addStep(call: ToolCall): (out: ToolOutput, ran: boolean) => void {
  const state = h('span', { class: 'state running', 'aria-label': 'running' });
  const details = h('details', { class: 'step' }, h('summary', {}, state, ' ', describe(call)));
  add(details);
  return (out, ran) => {
    state.className = `state ${out.isError ? 'failed' : 'ok'}`;
    state.setAttribute('aria-label', out.isError ? (ran ? 'failed' : 'not run') : 'done');
    if (out.isError) details.querySelector('summary')!.append(h('span', { class: 'code' }, ` ${out.text.match(/^Error (\w+)/)?.[1] ?? 'failed'}`));
    details.append(h('pre', {}, out.text));
    if (out.image) details.append(h('img', { src: `data:${out.image.mime};base64,${out.image.data}`, alt: 'Screenshot the assistant took' }));
    scrollToEnd();
  };
}

function showEmpty(): void {
  log.replaceChildren(
    h('div', { class: 'empty' },
      h('p', {}, h('strong', {}, 'Ask the assistant to do something in your browser.')),
      h('p', { class: 'muted' }, 'For example: "Open bbc.com/bangla and summarise the top story", or "আমার জন্য example.com-এর ফর্মটা পূরণ করো".'),
      h('p', { class: 'muted' }, 'It works in tabs of the "UABC" group, asks before using a new site, and never types passwords. Stop it any time with Alt+Shift+K.')),
  );
}

// ----- header, banner ----------------------------------------------------------

function renderModels(): void {
  const providers = config.providers.filter(usable);
  const sel = config.selected;
  const groups = providers.map((p) => {
    const models = [...p.models];
    if (sel?.provider === p.id && !models.some((m) => m.id === sel.model)) models.unshift({ id: sel.model });
    return h('optgroup', { label: p.label }, ...models.map((m) => {
      const option = h('option', { value: JSON.stringify([p.id, m.id]) }, m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id);
      option.selected = sel?.provider === p.id && sel.model === m.id;
      return option;
    }));
  });
  modelSelect.replaceChildren(...(groups.length ? groups : [h('option', { value: '' }, 'No model set up')]));
  modelSelect.disabled = !groups.length || running !== null;
}

function renderBanner(): void {
  const blocks: Node[] = [];
  if (!currentSelection(config)) {
    blocks.push(
      h('section', { class: 'notice' },
        h('strong', {}, config.providers.some(usable) ? 'Choose a model above.' : 'Add an API key to start.'),
        h('p', {}, 'Use OpenAI, Anthropic (Claude), Google Gemini, OpenRouter or a local model (Ollama, LM Studio). Keys stay in this browser and go only to the provider you pick.'),
        h('button', { class: 'primary', onclick: () => void chrome.runtime.openOptionsPage() }, 'Open settings')),
    );
  }
  if (status?.settings.paused) {
    blocks.push(
      h('section', { class: 'notice warn' },
        h('strong', {}, 'AI control is paused.'),
        h('p', {}, status.settings.pausedReason ?? ''),
        h('button', { onclick: () => void ui('resume').then(refreshStatus) }, '▶ Resume')),
    );
  }
  for (const a of status?.approvals ?? []) {
    if (a.session !== backend.session) continue;
    blocks.push(
      h('section', { class: 'notice warn' },
        h('strong', {}, 'The assistant wants to use this site:'),
        h('p', { class: 'mono' }, a.origin),
        h('div', { class: 'row' },
          h('button', { onclick: () => void ui('approval.decide', { id: a.id, decision: 'deny' }).then(refreshStatus) }, 'Deny'),
          h('button', { onclick: () => void ui('approval.decide', { id: a.id, decision: 'session' }).then(refreshStatus) }, 'Allow this time'),
          h('button', { class: 'primary', onclick: () => void ui('approval.decide', { id: a.id, decision: 'always' }).then(refreshStatus) }, 'Always allow'))),
    );
  }
  banner.replaceChildren(...blocks);
}

async function refreshStatus(): Promise<void> {
  try {
    status = await ui<Status>('status');
  } catch {
    status = null;
  }
  renderBanner();
}

function setRunning(on: boolean): void {
  sendButton.textContent = on ? '■ Stop' : 'Send';
  sendButton.classList.toggle('danger', on);
  sendButton.classList.toggle('primary', !on);
  sendButton.setAttribute('aria-label', on ? 'Stop the assistant' : 'Send');
  modelSelect.disabled = on || !config.providers.some(usable);
}

// ----- sending ------------------------------------------------------------------

async function send(): Promise<void> {
  if (running) {
    running.abort();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  const sel = currentSelection(config);
  if (!sel) {
    renderBanner();
    return;
  }
  input.value = '';
  autosize();
  add(h('div', { class: 'msg user' }, text));
  // Tools and system prompt are fixed per conversation; a model that cannot
  // see images gets no screenshot tool.
  conversation ??= newConversation({ screenshots: config.screenshots && sel.info?.vision !== false });
  backend.setClientName(`UABC assistant (${sel.model})`);
  running = new AbortController();
  setRunning(true);
  const poll = setInterval(() => void refreshStatus(), 1000);
  const total = { input: 0, output: 0, cached: 0 };
  let servedBy = '';
  const pending = new Map<string, (out: ToolOutput, ran: boolean) => void>();
  try {
    const outcome = await runTurn(conversation, text, {
      provider: sel.provider,
      model: sel.model,
      maxOutput: sel.info?.maxOutput,
      runner,
      maxSteps: config.maxSteps,
      signal: running.signal,
      events: {
        text: (t) => add(h('div', { class: 'msg assistant' }, ...renderMarkdown(t))),
        toolStart: (call) => pending.set(call.id, addStep(call)),
        toolEnd: (call, out, ran) => pending.get(call.id)?.(out, ran),
        notice: addNotice,
        thinking: (on) => {
          if (on) log.append(thinking);
          else thinking.remove();
          scrollToEnd();
        },
        usage: (u, model) => {
          total.input += u.input ?? 0;
          total.output += u.output ?? 0;
          total.cached += u.cached ?? 0;
          if (model && !model.startsWith(sel.model)) servedBy = model;
        },
      },
    });
    if (outcome === 'stopped') addNotice('info', 'Stopped.');
  } finally {
    clearInterval(poll);
    running = null;
    setRunning(false);
    void refreshStatus();
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    usageLine.textContent = total.input || total.output
      ? `Last reply: ${k(total.input)} tokens in${total.cached ? ` (${k(total.cached)} cached)` : ''}, ${k(total.output)} out${servedBy ? ` · answered by ${servedBy}` : ''}`
      : '';
    input.focus();
  }
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ----- wiring ---------------------------------------------------------------------

sendButton.addEventListener('click', () => void send());
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
});
modelSelect.addEventListener('change', () => {
  try {
    const [provider, model] = JSON.parse(modelSelect.value) as [string, string];
    void updateConfig((c) => (c.selected = { provider, model }));
  } catch {
    // placeholder option
  }
});
$<HTMLButtonElement>('new').addEventListener('click', () => {
  running?.abort();
  conversation = null;
  usageLine.textContent = '';
  showEmpty();
  input.focus();
});
$<HTMLButtonElement>('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());

onConfigChange((c) => {
  config = c;
  renderModels();
  renderBanner();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'paused' in changes) void refreshStatus();
});

void (async () => {
  config = await loadConfig();
  backend.connect();
  showEmpty();
  renderModels();
  await refreshStatus();
  input.focus();
})();
