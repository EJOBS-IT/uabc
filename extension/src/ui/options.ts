import { assistantSection } from './assistant-settings';
import { type AuditEntry, METHOD_LABELS, type Status, ago, h, ui } from './common';
import { remoteSection } from './remote-settings';

const root = document.getElementById('app')!;
let error = '';

async function act(op: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    error = '';
    await ui(op, extra);
  } catch (e) {
    error = (e as Error).message;
  }
  await render();
}

function radio(name: string, value: string, current: string, title: string, detail: string, danger = false) {
  return h('label', { class: danger ? 'choice danger-text' : 'choice' },
    h('input', { type: 'radio', name, value, ...(value === current ? { checked: true } : {}), onchange: () => void act('settings.set', { [name]: value }) }),
    h('span', {}, h('strong', {}, title), h('br'), h('small', {}, detail)));
}

async function render(): Promise<void> {
  const [st, log] = await Promise.all([ui<Status>('status'), ui<AuditEntry[]>('audit.get', { limit: 200 })]);
  const connected = st.bridge.state === 'connected';
  const labelInput = h('input', { type: 'text', value: st.settings.label, placeholder: 'e.g. Work', maxlength: '40' });
  const grantInput = h('input', { type: 'text', placeholder: 'example.com or https://*.example.com' });

  const blocks: Array<Node | null> = [
    h('header', {}, h('img', { src: 'icons/48.png', alt: '' }), h('h1', {}, 'UABC – Universal AI Browser Controller')),
    error ? h('section', { class: 'notice bad' }, error) : null,

    await assistantSection(render, st.storageLocked),

    h('section', { class: 'card', id: 'local-tools' },
      h('h2', {}, 'Connect your AI tools'),
      h('p', {}, 'Claude Code, Codex, Antigravity, Cursor, Gemini CLI, VS Code and other MCP clients reach this browser through the small local ', h('code', {}, 'uabc'), ' bridge.'),
      connected
        ? h('p', { class: 'ok-text' }, `Bridge connected (uabc ${st.bridge.host?.version ?? ''}).`)
        : h('p', { class: 'muted' }, `Bridge: ${st.bridge.state === 'missing' ? 'not installed' : st.bridge.state}${st.bridge.error && st.bridge.state !== 'missing' ? ` (${st.bridge.error})` : ''}. The built-in assistant works without it.`),
      h('ol', {},
        h('li', {}, 'Download the ', h('code', {}, 'uabc'), ' program for your system and put it somewhere permanent.'),
        h('li', {}, 'Run ', h('code', {}, 'uabc install'), ' once. It registers the bridge with your browsers.'),
        h('li', {}, 'Add UABC to your AI tool: ', h('code', {}, 'uabc config claude-code'), ' prints the setup line; also ', h('code', {}, 'codex'), ', ', h('code', {}, 'antigravity'), ', ', h('code', {}, 'cursor'), ', ', h('code', {}, 'gemini'), ', ', h('code', {}, 'vscode'), '.'),
        h('li', {}, 'Ask your AI to use the browser. New sites need your approval; stop everything with Alt+Shift+K.')),
      connected ? null : h('button', { onclick: () => void act('reconnect') }, 'Retry connection')),

    remoteSection(st, act),

    h('section', { class: 'card' },
      h('h2', {}, 'Site access'),
      radio('mode', 'ask', st.settings.mode, 'Ask me for each new site (recommended)', 'A prompt appears the first time an AI wants to read or act on a website.'),
      radio('mode', 'listed', st.settings.mode, 'Only approved sites', 'Never ask; anything not on the list below is refused. Good for unattended runs.'),
      radio('mode', 'all', st.settings.mode, 'All sites without asking (developer mode)', 'Dangerous: any page the AI visits can try to manipulate it.', true),
      h('h3', {}, 'Always-allowed sites'),
      st.grants.length
        ? h('ul', { class: 'grants' }, ...st.grants.map((g) =>
            h('li', {}, h('span', { class: 'mono' }, g.origin), h('small', { class: 'muted' }, ` added ${ago(g.added)}${g.by ? ` by ${g.by}` : ''}`),
              h('button', { class: 'small', onclick: () => void act('grant.remove', { origin: g.origin }) }, 'Remove'))))
        : h('p', { class: 'muted' }, 'None yet.'),
      h('div', { class: 'row' }, grantInput, h('button', { onclick: () => void act('grant.add', { origin: grantInput.value }) }, 'Add'))),

    h('section', { class: 'card' },
      h('h2', {}, 'Input mode'),
      radio('inputMode', 'trusted', st.settings.inputMode, 'Trusted input (recommended)', 'Real mouse and keyboard events through the DevTools protocol. Chrome shows a "started debugging this browser" bar while an AI is acting; clicking Cancel there stops the AI.'),
      radio('inputMode', 'basic', st.settings.inputMode, 'Basic input', 'Synthetic events from a page script. No banner, but some sites ignore them. Use this if your administrator blocks the debugger.')),

    h('section', { class: 'card' },
      h('h2', {}, 'This browser profile'),
      h('p', { class: 'muted' }, 'With several browser profiles open, pick one with ', h('code', {}, 'uabc mcp --target <name>'), '.'),
      h('div', { class: 'row' }, labelInput, h('button', { onclick: () => void act('settings.set', { label: labelInput.value }) }, 'Save name'))),

    h('section', { class: 'card' },
      h('h2', {}, 'Activity log'),
      h('p', { class: 'muted' }, 'Everything AI agents did in this browser (kept locally, last 500 actions).'),
      log.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Client'), h('th', {}, 'Action'), h('th', {}, 'Details'), h('th', {}, 'Result'))),
            h('tbody', {}, ...log.map((e) =>
              h('tr', { class: e.ok ? '' : 'failed' },
                h('td', {}, new Date(e.t).toLocaleString()), h('td', {}, e.client), h('td', {}, METHOD_LABELS[e.method] ?? e.method),
                h('td', { class: 'detail' }, e.detail ?? ''), h('td', {}, e.ok ? '✓' : (e.code ?? '✗'))))))
        : h('p', { class: 'muted' }, 'Nothing yet.'),
      h('button', { onclick: () => void act('audit.clear') }, 'Clear log')),

    h('section', { class: 'card' },
      h('h2', {}, 'Diagnostics'),
      h('dl', {},
        h('dt', {}, 'Extension'), h('dd', { class: 'mono' }, `${st.extension.id} · v${st.extension.version}`),
        h('dt', {}, 'Profile id'), h('dd', { class: 'mono' }, st.settings.instanceId),
        h('dt', {}, 'Bridge'), h('dd', { class: 'mono' }, st.bridge.host ? `uabc ${st.bridge.host.version} · pid ${st.bridge.host.pid} · ${st.bridge.host.endpoint ?? ''}` : st.bridge.state),
        h('dt', {}, 'Last error'), h('dd', { class: 'mono' }, st.bridge.error || '–'))),
  ];
  root.replaceChildren(...blocks.filter((b): b is Node => b !== null));
}

void render();
