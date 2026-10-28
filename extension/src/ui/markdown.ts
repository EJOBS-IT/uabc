// A small, safe Markdown subset for assistant replies: paragraphs, lists,
// headings, code blocks, `code`, **bold** and http(s) links. Built from DOM
// nodes and textContent only; model output never becomes HTML.

import { h } from './common';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

function inline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, m[2].slice(2, -2)));
    else {
      // Link text is chosen by the model (and maybe by a page): always show where it goes.
      const host = new URL(m[4]!).host;
      out.push(h('a', { href: m[4]!, target: '_blank', rel: 'noopener noreferrer', title: m[4]! }, m[3]!));
      if (!m[3]!.includes(host)) out.push(h('span', { class: 'link-host' }, ` (${host})`));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;

export function renderMarkdown(text: string): Node[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push(h('pre', {}, h('code', {}, body.join('\n'))));
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? 'ol' : 'ul', {});
      for (; i < lines.length && LIST_ITEM.test(lines[i]!); i++) list.append(h('li', {}, ...inline(lines[i]!.replace(LIST_ITEM, ''))));
      out.push(list);
    } else if (/^#{1,6}\s+/.test(line)) {
      out.push(h('p', { class: 'heading' }, ...inline(line.replace(/^#{1,6}\s+/, ''))));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !LIST_ITEM.test(lines[i]!) && !/^\s*```|^#{1,6}\s/.test(lines[i]!); i++) para.push(lines[i]!);
      out.push(h('p', {}, ...inline(para.join('\n'))));
    }
  }
  return out;
}
