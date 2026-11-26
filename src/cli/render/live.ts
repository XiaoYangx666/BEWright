import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { IncrementalPreview, type PreviewSnapshot } from '../../preview/incremental.js';
import { livePage } from './live-page.js';
import type { Browser, Page } from 'playwright';
import type { SnapshotRequest } from './prepare.js';

/** Compiled builds use the sibling dist worker; tsx source mode needs the TS file. */
const workerPath = (() => {
  const compiled = fileURLToPath(new URL('./live-worker.js', import.meta.url));
  return existsSync(compiled) ? compiled : fileURLToPath(new URL('./live-worker.ts', import.meta.url));
})();

export type LiveLighting = { ambient?: number; exposure?: number; curve?: number; day?: number };

/** Valid ranges shared by the page sliders and the /lighting endpoint. */
const LIGHTING_RANGES = { ambient: [0, 0.9], exposure: [0.4, 2.5], curve: [0.6, 3], day: [0, 1] } as const;

type Pose = { eye: [number, number, number]; target: [number, number, number] };
type ShotOptions = LiveLighting & { eye?: number[]; target?: number[]; width?: number; height?: number };

export async function startLivePreview(options: {
  request: SnapshotRequest;
  root: string;
  port: number;
  watchPaths: string[];
  background?: string;
  lighting?: LiveLighting;
  agent?: boolean;
}) {
  const roots = [...new Set([options.root, ...options.watchPaths].map((path) => resolve(path)))];
  for (const root of roots)
    if (!(await stat(root)).isDirectory()) throw new Error(`Watch path must be a directory: ${root}`);
  const lighting = {
    ambient: options.lighting?.ambient ?? 0.18,
    exposure: options.lighting?.exposure ?? 1,
    curve: options.lighting?.curve ?? 1.45,
    day: options.lighting?.day ?? 1,
  };
  // Frozen before light toggles, so page-local storage keys stay stable.
  const storageKey = JSON.stringify([options.root, options.request]);
  let lightRequested = options.request.cli.light;
  let lightEnabled = lightRequested;
  let pose: Pose | null = null;
  // The screenshot browser is launched lazily on the first /screenshot call; a
  // plain watch server keeps running without Playwright.
  let browser: Browser | null = null;
  let pagePromise: Promise<Page> | null = null;
  let shotChain: Promise<void> = Promise.resolve();
  const ensurePage = (): Promise<Page> => {
    if (!pagePromise) {
      pagePromise = (async () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : options.port;
        const { chromium } = await import('playwright');
        browser = await chromium.launch({
          channel: process.env.BROWSER_CHANNEL ?? 'chrome',
          headless: true,
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        });
        const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(
          () => Boolean((window as unknown as { blockwrightPreview?: unknown }).blockwrightPreview),
          undefined,
          { timeout: 120_000 },
        );
        return page;
      })();
    }
    return pagePromise;
  };
  const cache = new IncrementalPreview();
  const clients = new Set<ServerResponse>();
  let metadata: PreviewSnapshot['camera'] | undefined;
  let views: PreviewSnapshot['views'], support: PreviewSnapshot['support'];
  let bounds: PreviewSnapshot['region'] | undefined;
  let metrics: ReturnType<IncrementalPreview['update']> | undefined;
  let status = 'building',
    error: string | undefined;
  let running = false,
    pending = false,
    closed = false;
  let child: ChildProcess | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const notify = () => {
    for (const response of clients) response.write('data: update\n\n');
  };
  const threeModule = new URL(import.meta.resolve('three'));
  const assets = new Map([
    ['/three/three.module.js', threeModule],
    ['/three/three.core.js', new URL('./three.core.js', threeModule)],
    ['/three/OrbitControls.js', new URL(import.meta.resolve('three/addons/controls/OrbitControls.js'))],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.setHeader('Cache-Control', 'no-store');
      // Scriptable lighting control: agents tune the preview without any rebuild.
      if (url.pathname === '/lighting') {
        if (request.method === 'POST') {
          let body = '';
          request.on('data', (chunk) => (body += chunk));
          request.on('end', () => {
            try {
              const values = JSON.parse(body || '{}');
              if (typeof values !== 'object' || values === null || Array.isArray(values))
                throw new Error('Expected a JSON object');
              for (const [key, [min, max]] of Object.entries(LIGHTING_RANGES)) {
                if ((values as Record<string, unknown>)[key] === undefined) continue;
                const value = Number((values as Record<string, unknown>)[key]);
                if (!Number.isFinite(value) || value < min || value > max)
                  throw new Error(`${key} must be a number from ${min} to ${max}`);
                lighting[key as keyof typeof lighting] = value;
              }
              // The propagation itself is opt-in and toggled by a rebuild.
              if (values.light !== undefined) {
                const want = Boolean(values.light);
                if (want !== lightRequested) {
                  lightRequested = want;
                  options.request = { ...options.request, cli: { ...options.request.cli, light: want } };
                  schedule();
                }
              }
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ ...lighting, light: lightRequested }));
              notify();
            } catch (cause) {
              response.writeHead(400).end(cause instanceof Error ? cause.message : String(cause));
            }
          });
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ...lighting, light: lightRequested }));
        return;
      }
      // Scriptable camera: agents drive the viewpoint that /screenshot captures
      // and any open page follows.
      if (url.pathname === '/camera') {
        if (request.method === 'POST') {
          let body = '';
          request.on('data', (chunk) => (body += chunk));
          request.on('end', () => {
            try {
              const values = JSON.parse(body || '{}');
              const isVec = (value: unknown) =>
                Array.isArray(value) && value.length === 3 && value.every((entry) => Number.isFinite(entry));
              if (!isVec(values.eye) || !isVec(values.target)) throw new Error('eye and target must be [x,y,z]');
              pose = { eye: values.eye.map(Number), target: values.target.map(Number) };
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify(pose));
              notify();
            } catch (cause) {
              response.writeHead(400).end(cause instanceof Error ? cause.message : String(cause));
            }
          });
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(pose));
        return;
      }
      // One PNG per request, rendered by the page itself at the requested pose.
      if (url.pathname === '/screenshot') {
        try {
          const params = url.searchParams;
          const parseVector = (name: string) => {
            const raw = params.get(name);
            if (raw === null) return undefined;
            const parts = raw.split(',').map(Number);
            if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error(`${name} must be x,y,z`);
            return parts;
          };
          const parseNumber = (name: string) => {
            const raw = params.get(name);
            if (raw === null) return undefined;
            const value = Number(raw);
            if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
            return value;
          };
          const shot: ShotOptions = {
            eye: parseVector('eye'),
            target: parseVector('target'),
            ambient: parseNumber('ambient'),
            exposure: parseNumber('exposure'),
            curve: parseNumber('curve'),
            day: parseNumber('day'),
            width: parseNumber('width'),
            height: parseNumber('height'),
          };
          shotChain = shotChain.then(async () => {
            try {
              if (closed) return;
              if (status !== 'ready') {
                response.writeHead(409, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: 'model not ready', status }));
                return;
              }
              const page = await ensurePage();
              const revision = cache.revision;
              await page.waitForFunction(
                (expected) => (window as unknown as { blockwrightPreview: { revision: number } }).blockwrightPreview
                  .revision >= expected,
                revision,
                { timeout: 60_000 },
              );
              const dataUrl = (await page.evaluate(
                async (shotOptions) =>
                  await (window as unknown as { blockwrightPreview: { snapshot(shot: ShotOptions): Promise<string> } })
                    .blockwrightPreview.snapshot(shotOptions),
                shot,
              )) as string;
              response.setHeader('Content-Type', 'image/png');
              response.end(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
            } catch (cause) {
              if (!response.headersSent) response.writeHead(500);
              response.end(cause instanceof Error ? cause.message : String(cause));
            }
          });
        } catch (cause) {
          if (!response.headersSent) response.writeHead(400);
          response.end(cause instanceof Error ? cause.message : String(cause));
        }
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(livePage(storageKey, options.background, options.agent === true));
      } else if (url.pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write('data: update\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
      } else if (url.pathname === '/state') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            revision: cache.revision,
            status,
            error,
            camera: metadata,
            views,
            support,
            bounds,
            metrics,
            lighting: { ...lighting, light: lightEnabled },
            light: lightEnabled,
            agent: options.agent === true,
            pose,
            chunks: Object.fromEntries([...cache.buffers].map(([key, value]) => [key, value.version])),
          }),
        );
      } else if (url.pathname === '/chunk') {
        const entry = cache.buffers.get(url.searchParams.get('key') ?? '');
        if (!entry || String(entry.version) !== url.searchParams.get('version')) {
          response.writeHead(409).end();
          return;
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(entry.data);
      } else if (assets.has(url.pathname)) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(assets.get(url.pathname)!));
      } else response.writeHead(404).end();
    } catch (cause) {
      response.writeHead(500).end(String(cause));
    }
  });

  async function rebuild() {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    status = 'building';
    error = undefined;
    notify();
    const started = performance.now();
    try {
      const snapshot = await new Promise<PreviewSnapshot>((accept, reject) => {
        // A fresh process reloads the entire ESM dependency graph, including helper modules.
        const worker = fork(workerPath, [], {
          serialization: 'advanced',
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        child = worker;
        const timer = setTimeout(() => {
          worker.kill();
          reject(new Error('Building exceeded 120 seconds'));
        }, 120_000);
        worker.once('message', (message: { snapshot?: PreviewSnapshot; error?: string }) => {
          clearTimeout(timer);
          worker.kill();
          if (message.snapshot) accept(message.snapshot);
          else reject(new Error(message.error ?? 'Worker returned no model'));
        });
        worker.once('error', (cause) => {
          clearTimeout(timer);
          reject(cause);
        });
        worker.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Build worker exited (${code})`));
        });
        worker.send(options.request);
      });
      if (closed) return;
      metrics = cache.update(snapshot);
      metadata = snapshot.camera;
      views = snapshot.views;
      support = snapshot.support;
      bounds = snapshot.region;
      lightEnabled = snapshot.light === true;
      status = 'ready';
      console.log(
        JSON.stringify({ revision: cache.revision, ...metrics, totalMs: Math.round(performance.now() - started) }),
      );
    } catch (cause) {
      status = 'error';
      error = cause instanceof Error ? cause.message : String(cause);
      console.error(error);
    } finally {
      running = false;
      notify();
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  }
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void rebuild(), 150);
  };
  const close = () => {
    closed = true;
    if (debounce) clearTimeout(debounce);
    child?.kill();
    watchers.forEach((watcher) => watcher.close());
    clients.forEach((response) => response.end());
    server.close();
    server.closeAllConnections();
    browser?.close().catch(() => undefined);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
  };
  try {
    for (const root of roots) {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename || /\.(?:[cm]?[jt]sx?|json)$/.test(String(filename))) schedule();
      });
      watcher.on('error', (cause) => {
        status = 'error';
        error = `File watcher: ${cause.message}`;
        notify();
      });
      watchers.push(watcher);
    }
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', accept);
    });
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    const address = server.address();
    console.log(
      `Live preview: http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}/${options.agent ? ' (agent mode)' : ''}`,
    );
    void rebuild();
    return { close, server };
  } catch (cause) {
    close();
    throw cause;
  }
}
