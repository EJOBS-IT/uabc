// Settings for the built-in assistant: API keys, OpenAI-compatible endpoints,
// the default model, step limit and screenshots. Keys are shown masked once
// saved and are never sent anywhere except their provider's API.

import { currentSelection, loadConfig, maskKey, updateConfig, usable } from '../assistant/config';
import { baseUrlProblem } from '../assistant/http';
import { COMPATIBLE_PRESETS, PRESETS, providerFor } from '../assistant/providers';
import type { AssistantConfig, ModelInfo, ProviderConfig } from '../assistant/types';
import { ago, h } from './common';

type Rerender = () => Promise<void>;
const models = (n: number) => `${n} model${n === 1 ? '' : 's'}`;
const results = new Map<string, { ok: boolean; text: string }>();
let busy = '';

function keyProblem(key: string): string | null {
  if (!key) return 'Paste the API key first.';
  if (/\s/.test(key) || key.length > 512) return 'That does not look like an API key (it contains spaces or is too long).';
  return null;
}

/** Loads the provider's models; the key is checked as a side effect. */
async function fetchModels(p: ProviderConfig): Promise<ModelInfo[]> {
  return providerFor(p.kind).listModels(p);
}

function chooseDefault(c: AssistantConfig, p: ProviderConfig, suggested?: string): void {
  if (currentSelection(c) || !p.models.length) return;
  const model = (suggested && p.models.find((m) => m.id === suggested)?.id) ?? p.models[0]!.id;
  c.selected = { provider: p.id, model };
}

async function saveProvider(p: ProviderConfig, manualModels: string[], rerender: Rerender, suggested?: string): Promise<void> {
  busy = p.id;
  await rerender();
  let found: ModelInfo[] = [];
  try {
    found = await fetchModels(p);
    results.set(p.id, { ok: true, text: `Connected: ${models(found.length)} available.` });
  } catch (e) {
    results.set(p.id, { ok: false, text: (e as Error).message });
  }
  const manual = manualModels.filter((id) => !found.some((m) => m.id === id)).map((id) => ({ id }));
  await updateConfig((c) => {
    const saved: ProviderConfig = { ...p, models: [...manual, ...found], ...(found.length ? { modelsFetchedAt: Date.now() } : {}) };
    const i = c.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) c.providers[i] = saved;
    else c.providers.push(saved);
    chooseDefault(c, saved, suggested);
  });
  busy = '';
  await rerender();
}

async function removeProvider(id: string, rerender: Rerender): Promise<void> {
  results.delete(id);
  await updateConfig((c) => {
    c.providers = c.providers.filter((p) => p.id !== id);
    if (c.selected?.provider === id) delete c.selected;
  });
  await rerender();
}

function resultLine(id: string): Node | null {
  if (busy === id) return h('p', { class: 'muted' }, 'Checking…');
  const r = results.get(id);
  return r ? h('p', { class: r.ok ? 'ok-text' : 'bad-text', role: r.ok ? 'status' : 'alert' }, r.text) : null;
}

function presetBlock(config: AssistantConfig, preset: (typeof PRESETS)[number], rerender: Rerender): Node {
  const saved = config.providers.find((p) => p.id === preset.id);
  const keyInput = h('input', { type: 'password', placeholder: saved?.apiKey ? `Saved: ${maskKey(saved.apiKey)} (paste a new key to replace it)` : 'Paste your API key', autocomplete: 'off', spellcheck: 'false' });
  const save = async () => {
    const key = keyInput.value.trim();
    const problem = keyProblem(key);
    if (problem) {
      results.set(preset.id, { ok: false, text: problem });
      return rerender();
    }
    await saveProvider({ id: preset.id, kind: preset.kind, label: preset.label, baseUrl: preset.baseUrl, apiKey: key, models: [] }, [], rerender, preset.suggested);
  };
  return h('div', { class: 'provider' },
    h('div', { class: 'title' },
      h('strong', {}, preset.label),
      saved?.apiKey
        ? h('small', { class: 'muted' }, `${models(saved.models.length)}${saved.modelsFetchedAt ? `, updated ${ago(saved.modelsFetchedAt)}` : ''}`)
        : h('a', { href: preset.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key')),
    h('div', { class: 'row' },
      keyInput,
      h('button', { onclick: () => void save() }, saved?.apiKey ? 'Replace key' : 'Save key'),
      saved ? h('button', { onclick: () => void saveProvider(saved, [], rerender, preset.suggested) }, 'Refresh models') : null,
      saved ? h('button', { onclick: () => void removeProvider(preset.id, rerender) }, 'Remove') : null),
    resultLine(preset.id));
}

function customBlock(p: ProviderConfig, rerender: Rerender): Node {
  return h('div', { class: 'provider' },
    h('div', { class: 'title' },
      h('strong', {}, p.label),
      h('small', { class: 'muted mono' }, p.baseUrl)),
    h('p', { class: 'muted' }, `${p.apiKey ? `Key ${maskKey(p.apiKey)}` : 'No key'} · ${models(p.models.length)}`),
    h('div', { class: 'row' },
      h('button', { onclick: () => void saveProvider(p, p.models.map((m) => m.id), rerender) }, 'Refresh models'),
      h('button', { onclick: () => void removeProvider(p.id, rerender) }, 'Remove')),
    resultLine(p.id));
}

function addCustomForm(rerender: Rerender): Node {
  const list = h('datalist', { id: 'compatible-presets' }, ...COMPATIBLE_PRESETS.map((x) => h('option', { value: x.baseUrl }, x.label)));
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Ollama', maxlength: '40' });
  const url = h('input', { type: 'url', placeholder: 'Address, e.g. http://localhost:11434/v1', list: 'compatible-presets' });
  const key = h('input', { type: 'password', placeholder: 'API key (if the server needs one)', autocomplete: 'off' });
  const modelIds = h('input', { type: 'text', placeholder: 'Model ids, comma separated (optional if the server lists them)' });
  url.addEventListener('change', () => {
    const preset = COMPATIBLE_PRESETS.find((x) => x.baseUrl === url.value);
    if (preset && !name.value) name.value = preset.label.replace(/ \(.*\)$/, '');
  });
  const add = async () => {
    const baseUrl = url.value.trim().replace(/\/+$/, '');
    const problem = baseUrlProblem(baseUrl) ?? (key.value.trim() ? keyProblem(key.value.trim()) : null);
    if (problem) {
      results.set('new', { ok: false, text: problem });
      return rerender();
    }
    results.delete('new');
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    const manual = modelIds.value.split(',').map((m) => m.trim()).filter(Boolean);
    await saveProvider({ id, kind: 'compatible', label: name.value.trim() || new URL(baseUrl).host, baseUrl, apiKey: key.value.trim(), models: [] }, manual, rerender);
  };
  return h('div', { class: 'provider' },
    h('strong', {}, 'Add an OpenAI-compatible endpoint'),
    h('p', { class: 'muted' }, 'Local models (Ollama, LM Studio) or other providers (DeepSeek, Groq, Mistral, xAI, Together …). Plain http:// is accepted only for this computer; reach a model server elsewhere on your network through https or an SSH tunnel.'),
    list,
    h('div', { class: 'row' }, name, url),
    h('div', { class: 'row' }, key, modelIds),
    h('div', { class: 'row' }, h('button', { onclick: () => void add() }, 'Add endpoint')),
    resultLine('new'));
}

function modelPicker(config: AssistantConfig): Node {
  const providers = config.providers.filter(usable);
  if (!providers.length) return h('p', { class: 'muted' }, 'Save a key above to choose a model.');
  const sel = config.selected;
  const select = h('select', { class: 'wide' },
    ...providers.map((p) =>
      h('optgroup', { label: p.label }, ...p.models.map((m) => {
        const o = h('option', { value: JSON.stringify([p.id, m.id]) }, m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id);
        o.selected = sel?.provider === p.id && sel.model === m.id;
        return o;
      }))));
  select.addEventListener('change', () => {
    const [provider, model] = JSON.parse(select.value) as [string, string];
    void updateConfig((c) => (c.selected = { provider, model }));
  });
  return h('div', { class: 'row' }, h('label', {}, 'Model: '), select);
}

export async function assistantSection(rerender: Rerender, storageLocked: boolean): Promise<Node> {
  const config = await loadConfig();
  const windowId = (await chrome.windows.getCurrent().catch(() => undefined))?.id;
  const steps = h('input', { type: 'number', min: '5', max: '200', value: String(config.maxSteps) });
  steps.addEventListener('change', () => void updateConfig((c) => (c.maxSteps = Number(steps.value))).then(rerender));
  const shots = h('input', { type: 'checkbox', ...(config.screenshots ? { checked: true } : {}) });
  shots.addEventListener('change', () => void updateConfig((c) => (c.screenshots = shots.checked)));

  return h('section', { class: 'card', id: 'assistant' },
    h('h2', {}, 'Built-in AI assistant'),
    storageLocked
      ? null
      : h('p', { class: 'notice bad', role: 'alert' }, 'This browser cannot hide extension storage from page scripts, so a saved API key is less protected. Update Chrome before saving keys.'),
    h('p', {}, 'Chat with an AI that works in this browser, in the side panel, with your own API key. ',
      'Keys are stored only in this browser profile and sent only to the provider you choose. ',
      'What the assistant reads on a page (text and screenshots) goes to that provider.'),
    h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        // sidePanel.open needs this click's user gesture: no await before it.
        onclick: () => void (windowId !== undefined ? chrome.sidePanel.open({ windowId }) : Promise.resolve()).catch(() => {}),
      }, 'Open the assistant'),
      h('span', { class: 'muted' }, 'or press Alt+Shift+U')),
    h('h3', {}, 'Providers'),
    ...PRESETS.map((p) => presetBlock(config, p, rerender)),
    ...config.providers.filter((p) => p.kind === 'compatible').map((p) => customBlock(p, rerender)),
    addCustomForm(rerender),
    h('h3', {}, 'Default model'),
    modelPicker(config),
    h('h3', {}, 'Behaviour'),
    h('div', { class: 'row' }, h('label', {}, 'Stop and ask after this many steps: '), steps),
    h('label', { class: 'choice' }, shots,
      h('span', {}, h('strong', {}, 'Send screenshots to the model'), h('br'),
        h('small', {}, 'Lets the model see the page. Turn off for text-only models; applies to new chats.'))));
}
