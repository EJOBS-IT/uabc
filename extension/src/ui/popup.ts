import { type AuditEntry, METHOD_LABELS, type Status, ago, h, ui } from './common';

const root = document.getElementById('app')!;

async function render(): Promise<void> {
  const [st, log, [active], win] = await Promise.all([
    ui<Status>('status'),
    ui<AuditEntry[]>('audit.get', { limit: 6 }),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.windows.getCurrent(),
  ]);
  const shared = !!active && st.tabs.some((t) => t.id === active.id);
  const connected = st.bridge.state === 'connected';

  const pill = st.settings.paused
    ? h('span', { class: 'pill warn' }, 'Paused')
    : st.sessions.length
      ? h('span', { class: 'pill ok' }, 'Active')
      : h('span', { class: 'pill' }, 'Ready');

  const blocks: Node[] = [h('header', {}, h('img', { src: 'icons/32.png', alt: '' }), h('h1', {}, 'UABC'), pill)];

  blocks.push(
    h('section', {},
      h('button', {
        class: 'primary wide',
        // sidePanel.open needs this click's user gesture: no await before it.
        onclick: () => void chrome.sidePanel.open({ windowId: win.id! }).then(() => window.close(), () => {}),
      }, 'Open the assistant'),
      h('p', { class: 'hint' }, 'Chat with an AI that works in this browser · Alt+Shift+U')),
  );

  for (const a of st.approvals) {
    blocks.push(
      h('section', { class: 'notice warn' },
        h('strong', {}, `${a.client} is waiting for your approval`),
        h('p', { class: 'mono' }, a.origin),
        h('div', { class: 'row' },
          h('button', { onclick: () => void ui('approval.decide', { id: a.id, decision: 'deny' }).then(render) }, 'Deny'),
          h('button', { onclick: () => void ui('approval.decide', { id: a.id, decision: 'session' }).then(render) }, 'Allow this time'),
          h('button', { class: 'primary', onclick: () => void ui('approval.decide', { id: a.id, decision: 'always' }).then(render) }, 'Always (any client)'))),
    );
  }

  blocks.push(
    h('section', {},
      h('button', {
        class: st.settings.paused ? 'primary wide' : 'danger wide',
        onclick: () => void ui(st.settings.paused ? 'resume' : 'pause').then(render),
      }, st.settings.paused ? '▶ Resume AI control' : '■ Stop AI control'),
      h('p', { class: 'hint' }, st.settings.paused ? (st.settings.pausedReason ?? '') : 'Shortcut: Alt+Shift+K')),
  );

  blocks.push(
    h('section', {},
      h('h2', {}, 'AI clients'),
      st.sessions.length
        ? h('ul', {}, ...st.sessions.map((s) => h('li', {}, h('strong', {}, s.client.name), ` · since ${ago(s.opened)}`)))
        : h('p', { class: 'muted' }, 'None connected.'),
      st.remote.enabled
        ? h('p', { class: 'muted' }, `Remote access: ${st.remote.state === 'connected' ? 'connected to the relay' : st.remote.state}.`)
        : null,
      connected
        ? null
        : h('p', { class: 'muted' },
            st.bridge.state === 'missing' ? 'Local tools (Claude Code, Codex, Antigravity …) need the uabc bridge: ' : `Bridge ${st.bridge.state}. `,
            h('a', { href: 'options.html#local-tools', target: '_blank' }, st.bridge.state === 'missing' ? 'set it up' : 'details'))),
  );

  blocks.push(
    h('section', {},
      h('h2', {}, `Shared tabs (${st.tabs.length})`),
      h('p', { class: 'muted' }, 'AI agents only see tabs in the "UABC" tab group.'),
      active?.id !== undefined && /^https?:/.test(active.url ?? '')
        ? h('button', { onclick: () => void ui(shared ? 'unshare' : 'share', { tabId: active.id }).then(render) }, shared ? 'Stop sharing this tab' : 'Share this tab')
        : null),
  );

  blocks.push(
    h('section', {},
      h('h2', {}, 'Recent activity'),
      log.length
        ? h('ul', { class: 'log' }, ...log.map((e) =>
            h('li', { class: e.ok ? '' : 'failed' },
              h('span', { class: 'when' }, ago(e.t)),
              ` ${e.client} ${METHOD_LABELS[e.method] ?? e.method} `,
              h('span', { class: 'detail' }, e.detail ?? ''),
              e.ok ? '' : h('span', { class: 'code' }, ` ${e.code ?? 'failed'}`))))
        : h('p', { class: 'muted' }, 'Nothing yet.')),
  );

  blocks.push(h('footer', {}, h('a', { href: 'options.html', target: '_blank' }, 'Settings & approved sites'), h('span', {}, `v${st.extension.version}`)));
  root.replaceChildren(...blocks);
}

void render();
setInterval(() => void render(), 2000);
