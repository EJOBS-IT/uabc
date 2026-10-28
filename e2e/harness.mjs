// End-to-end harness: a real Chromium with the unpacked extension, the real
// `uabc` binary as native host, and the official MCP TypeScript SDK as the AI
// client — the same path Claude Code, Codex or Cursor take.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const UABC_BIN = process.env.UABC_BIN ?? join(root, 'target', 'debug', process.platform === 'win32' ? 'uabc.exe' : 'uabc');
const EXTENSION = join(root, 'extension', 'dist');
const FIXTURES = join(root, 'e2e', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 15_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function serveFixtures() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    const name = url.pathname.replace(/^\/+/, '') || 'form.html';
    const file = join(FIXTURES, name.replace(/[^a-z0-9._-]/gi, ''));
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function startEnvironment() {
  if (!existsSync(UABC_BIN)) throw new Error(`${UABC_BIN} missing: run \`cargo build\` first`);
  if (!existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('extension not built: run `npm run build:ext` first');

  const work = mkdtempSync(join(tmpdir(), 'uabc-e2e-'));
  const home = join(work, 'home');
  const profile = join(work, 'profile');
  const env = { ...process.env, UABC_HOME: home, UABC_LOG: 'debug' };
  execFileSync(UABC_BIN, ['install', '--dev', '--user-data-dir', profile], { env, stdio: 'pipe' });

  // One server per origin: one pre-approved, the others need a decision.
  const servers = await Promise.all([1, 2, 3, 4, 5].map(() => serveFixtures()));
  const [approved, other, third, fourth, fifth] = servers.map((s) => `http://127.0.0.1:${s.address().port}`);

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.UABC_E2E_HEADED !== '1',
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    env,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await waitFor(() => existsSync(join(home, 'instances')) && readdirSync(join(home, 'instances')).length > 0, 'the native host to register');
  await worker.evaluate((origin) => chrome.storage.local.set({ grants: [{ origin, added: Date.now(), by: 'e2e' }] }), approved);

  /** An AI client: its own `uabc mcp` process, as Claude Code or Cursor would start it. */
  async function connect(name) {
    const transport = new StdioClientTransport({ command: UABC_BIN, args: ['mcp'], env, stderr: 'pipe' });
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(transport);
    return {
      client,
      /** Calls a tool; returns { text, isError, images }. */
      async call(tool, args = {}) {
        const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180_000 });
        const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        const images = res.content.filter((c) => c.type === 'image');
        return { text, isError: res.isError === true, images };
      },
      close: () => client.close(),
    };
  }
  const main = await connect('uabc-e2e');
  const client = main.client;

  return {
    client, context, worker, home, origins: { approved, other, third, fourth, fifth }, connect,
    extensionId: new URL(worker.url()).host,
    call: main.call,
    /** The Playwright page showing `urlPart` (for checking what the page really did). */
    async page(urlPart) {
      return waitFor(() => context.pages().find((p) => p.url().includes(urlPart)), `a page at ${urlPart}`);
    },
    async stop() {
      await client.close().catch(() => {});
      await context.close().catch(() => {});
      for (const s of servers) s.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Asserts that every line containing `needle` sits inside an <untrusted-web-content> fence. */
export function assertFenced(text, needle) {
  let depth = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('<untrusted-web-content ')) depth++;
    else if (line === '</untrusted-web-content>') depth--;
    else if (line.includes(needle) && depth !== 1) throw new Error(`unfenced page text ${JSON.stringify(line)} in:\n${text}`);
  }
  if (depth !== 0) throw new Error(`unbalanced fences in:\n${text}`);
}

/** Collects approval prompt windows as they open. */
export function collectPrompts(context) {
  const prompts = [];
  const onPage = (p) => p.url().includes('approve.html') && prompts.push(p);
  context.on('page', onPage);
  return {
    prompts,
    async waitFor(n, timeout = 15_000) {
      const until = Date.now() + timeout;
      while (prompts.length < n) {
        if (Date.now() > until) throw new Error(`expected ${n} approval prompt(s), saw ${prompts.length}`);
        await sleep(50);
      }
      return prompts;
    },
    stop: () => context.off('page', onPage),
  };
}

/** Finds the ref of the first `[n] role "name…"` line in a browser_get_state result. */
export function refOf(stateText, role, namePattern) {
  for (const line of stateText.split('\n')) {
    const m = /^\[(\d+)\] (\S+)(?: "([^"]*)")?/.exec(line);
    if (m && m[2] === role && (m[3] ?? '').match(namePattern)) return m[1];
  }
  throw new Error(`no ${role} matching ${namePattern} in:\n${stateText}`);
}
