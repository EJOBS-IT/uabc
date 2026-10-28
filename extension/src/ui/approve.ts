import { h, ui } from './common';

interface Approval {
  id: string;
  origin: string;
  client: string;
  remote: boolean;
  purpose: string;
  expires: number;
}

const root = document.getElementById('app')!;
const id = new URLSearchParams(location.search).get('id') ?? '';

async function main(): Promise<void> {
  const a = await ui<Approval | null>('approval.get', { id });
  if (!a) {
    root.replaceChildren(h('p', { class: 'muted' }, 'This request is no longer pending.'));
    setTimeout(() => window.close(), 1500);
    return;
  }
  const choose = (decision: string) => async () => {
    await ui('approval.decide', { id, decision });
    window.close();
  };
  const countdown = h('span', { class: 'muted' });
  const tick = () => {
    const left = Math.max(0, Math.round((a.expires - Date.now()) / 1000));
    countdown.textContent = `Automatically denied in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 1000);

  root.replaceChildren(
    h('header', {}, h('img', { src: 'icons/32.png', alt: '' }), h('h1', {}, 'Site access request')),
    h('p', { class: 'lead' }, h('strong', {}, a.client), ' wants to ', a.purpose, ':'),
    h('p', { class: 'origin mono' }, a.origin),
    h('section', { class: 'notice warn' },
      h('p', {}, 'The AI will be able to read this site and act on it with your logged-in session.'),
      h('p', {}, 'Web pages can contain hidden instructions that try to mislead AI agents. Only allow sites you would let this AI use on your behalf.')),
    h('div', { class: 'row' },
      h('button', { onclick: choose('deny') }, 'Deny'),
      h('button', { onclick: choose('session'), title: `Only ${a.client}, ${a.remote ? 'until it is idle for 10 minutes' : 'until it disconnects'}` }, 'Allow this time'),
      h('button', { class: 'primary', onclick: choose('always'), title: 'Any AI client, until you remove it in settings' }, 'Always allow (any AI client)')),
    a.remote
      ? h('p', { class: 'muted' }, `${a.client} is an AI app connected through your relay. It names itself: anyone with your connector URL could use this name. "Allow this time" lasts until it has been idle for 10 minutes. "Always allow" applies to every AI client and can be removed in settings.`)
      : h('p', { class: 'muted' }, `"Allow this time" applies only to ${a.client} until it disconnects. "Always allow" applies to every AI client and can be removed in settings.`),
    h('p', {}, countdown),
  );
}

void main();
