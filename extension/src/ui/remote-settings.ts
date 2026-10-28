// Settings for remote access through a relay (Claude, ChatGPT and other AI
// apps in the cloud).

import { type Status, h } from './common';

type Act = (op: string, extra?: Record<string, unknown>) => Promise<void>;

export function remoteSection(st: Status, act: Act): Node {
  const r = st.remote;
  const relay = h('input', { type: 'url', placeholder: 'https://relay.example.com', value: r.relayUrl, 'aria-label': 'Relay address' });
  const code = h('input', { type: 'password', placeholder: 'optional', value: r.accessCode, autocomplete: 'off', 'aria-label': 'Relay access code' });
  const enabled = h('input', { type: 'checkbox', ...(r.enabled ? { checked: true } : {}) });
  enabled.addEventListener('change', () => void act('remote.set', { enabled: enabled.checked, relayUrl: relay.value }));
  const state = !r.enabled
    ? 'Remote access is off.'
    : !r.relayUrl
      ? 'Enter the address of a relay.'
      : r.state === 'connected'
        ? 'Connected to the relay.'
        : r.state === 'connecting'
          ? 'Connecting…'
          : `Not connected: ${r.error || 'unknown error'}. Retrying.`;
  const url = h('input', { type: 'text', readonly: true, value: r.connectorUrl, class: 'mono', 'aria-label': 'Connector URL' });
  const copied = h('span', { class: 'ok-text', role: 'status' });
  const copy = () =>
    void navigator.clipboard.writeText(r.connectorUrl).then(() => {
      copied.textContent = 'Copied.';
      setTimeout(() => (copied.textContent = ''), 2000);
    });

  return h('section', { class: 'card', id: 'remote' },
    h('h2', {}, 'Use this browser from Claude, ChatGPT and other AI apps'),
    h('p', {}, 'AI apps in the cloud reach this browser through a relay: the browser connects out to it, and the app gets a secret connector URL. ',
      'Every new site still needs your approval in this browser, and Stop works as usual.'),
    h('label', { class: 'choice' }, enabled,
      h('span', {}, h('strong', {}, 'Turn on remote access'), h('br'),
        h('small', {}, 'Use a relay you trust: it passes on what the AI app reads. You can run your own with uabc relay.'))),
    h('div', { class: 'row' }, h('label', {}, 'Relay: '), relay),
    h('div', { class: 'row' }, h('label', {}, 'Access code: '), code,
      h('button', { onclick: () => void act('remote.set', { relayUrl: relay.value, accessCode: code.value }) }, 'Save')),
    h('p', { class: 'muted' }, 'Only if your relay asks for one to add a browser. A new relay address gives this browser a new identity there.'),
    h('p', { class: r.enabled && r.state === 'connected' ? 'ok-text' : r.enabled && r.state === 'error' ? 'bad-text' : 'muted' }, state),
    r.enabled && r.connectorUrl
      ? h('div', {},
          h('h3', {}, 'Connector URL'),
          h('div', { class: 'row' }, url, h('button', { onclick: copy }, 'Copy'), h('button', { onclick: () => void act('remote.rotate') }, 'New URL'), copied),
          h('p', { class: 'notice warn' }, 'Treat this URL like a password: whoever has it can ask to use this browser (you still approve each site). "New URL" revokes the old one.'),
          h('ul', {},
            h('li', {}, h('strong', {}, 'Claude: '), 'add a custom connector and paste the URL.'),
            h('li', {}, h('strong', {}, 'ChatGPT: '), 'turn on developer mode, then add a connector with this URL and no authentication. Clicking and typing need a plan with full MCP write actions.'),
            h('li', {}, h('strong', {}, 'Gemini Enterprise: '), 'an admin adds a custom MCP server with this URL.'),
            h('li', {}, h('strong', {}, 'Others: '), 'any app that accepts a remote MCP server (Streamable HTTP) URL.')))
      : null);
}
