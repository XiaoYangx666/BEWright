import { createServer } from 'node:http';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { PROJECT_ROOT, atomicWrite, fileRecord } from '../../project/paths.js';
import { meshChunkDecoderSource } from '../../mesh/cache.js';
import type { Box, Vec3 } from '../../core/structure.js';
import type { DiagnosticMarker } from '../../preview/diagnostics.js';

export type RenderLegendEntry = Readonly<{ name: string; color: string }>;

export type RenderLighting = Readonly<{ ambient?: number; exposure?: number; curve?: number; day?: number }>;

/** Scene metadata consumed by the browser-side renderer. */
export type RenderScene = Readonly<{
  bounds: Box;
  chunkFiles: readonly string[];
  view?: string;
  fit?: 'geometry' | 'bounds';
  title?: string;
  diagnostics?: readonly { count: number }[];
  markers?: readonly DiagnosticMarker[];
  eye?: Vec3;
  target?: Vec3;
  direction?: Vec3;
  legend?: readonly RenderLegendEntry[];
  perspective?: boolean;
  lighting?: RenderLighting;
}>;

export type RenderOptions = Readonly<{
  scenes: Readonly<Record<string, RenderScene>>;
  /** Output directory for PNGs; relative paths resolve against the project root. */
  outDir: string;
  /**
   * Packed chunk buffers keyed by the `chunkFiles` prefix, served straight to
   * the browser. A caller that already holds the meshes in memory passes them
   * here instead of writing hundreds of megabytes to disk and reading them
   * back; entries not found here fall back to the filesystem.
   */
  chunks?: ReadonlyMap<string, Uint8Array>;
  width?: number;
  height?: number;
  background?: string;
  /** Restrict rendering to these scene names. */
  only?: readonly string[];
  /** Scene name -> requested view override. */
  viewOverrides?: Readonly<Record<string, string>>;
  /** Optional manifest to refresh with rendered file records. */
  manifestPath?: string;
  browserChannel?: string;
}>;

export type RenderResult = Readonly<{
  name: string;
  view: string;
  screenshot: string;
  drawCalls: number;
  triangles: number;
  fetchUploadRenderMs: number;
  includingScreenshotMs: number;
  device: string;
}>;

const MIME: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

function mime(path: string) {
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] ?? 'application/octet-stream';
}

/**
 * Headless Three.js renderer for generated mesh buffers. Starts a throwaway
 * localhost server so the browser can fetch chunk buffers, then closes both.
 */
export async function renderScenes(options: RenderOptions): Promise<RenderResult[]> {
  const width = options.width ?? 1280;
  const height = options.height ?? 960;
  const background = options.background ?? '#eaf0f4';
  const outDir = resolve(PROJECT_ROOT, options.outDir);
  const root = PROJECT_ROOT;
  const threeModule = new URL(import.meta.resolve('three'));
  const threeAssets = new Map([
    ['/three/three.module.js', threeModule],
    ['/three/three.core.js', new URL('./three.core.js', threeModule)],
  ]);

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/__render__') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>blockwright render</title><body></body>');
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      const asset = threeAssets.get(pathname);
      if (asset) {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await readFile(asset));
        return;
      }
      // In-memory chunks win over the filesystem: they are produced by this
      // process, so they bypass the path allowlist rather than being resolved.
      // Keys are `chunkFiles` prefixes, i.e. the request path without the
      // `.bin` suffix the loader appends.
      const inline = options.chunks?.get(decodeURIComponent(pathname.slice(1)).replace(/\.bin$/, ''));
      if (inline) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(inline);
        return;
      }
      const file = resolve(root, '.' + pathname);
      const allowed =
        file.startsWith(root + sep) &&
        (pathname.startsWith('/cache/') || pathname.startsWith('/artifacts/'));
      if (!allowed) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader('Content-Type', mime(file));
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  let browser;
  try {
    browser = await chromium.launch({
      channel: options.browserChannel ?? process.env.BROWSER_CHANNEL ?? 'chrome',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(message.text());
    });
    // A same-origin document is required before injecting the module script;
    // about:blank has an opaque origin and would block the cross-origin import.
    await page.goto(base + '/__render__', { waitUntil: 'commit' });
    await page.setContent(`<style>body{margin:0;background:${background}}canvas{display:block}</style>`);
    await page.addScriptTag({ type: 'module', content: browserScript(base, width, height, background) });
    await page
      .waitForFunction(() => typeof (window as unknown as { renderScene?: unknown }).renderScene === 'function')
      .catch(() => {
        throw new Error(`Renderer failed to initialise: ${errors.join(' | ') || 'no diagnostics'}`);
      });

    const results: RenderResult[] = [];
    const names = options.only ?? Object.keys(options.scenes);
    for (const name of names) {
      const scene = options.scenes[name];
      if (!scene) throw new Error(`Unknown scene: ${name}`);
      const view = options.viewOverrides?.[name] ?? scene.view ?? 'iso';
      const metrics = (await page.evaluate(
        async (payload) =>
          (window as unknown as { renderScene: (value: unknown) => Promise<RenderResult> }).renderScene(payload),
        { name, view, scene },
      )) as Omit<RenderResult, 'screenshot' | 'includingScreenshotMs'>;
      // A scene that names chunk files but uploads no geometry means the cache
      // writer and this loader disagree; a silent blank PNG is not acceptable.
      if (scene.chunkFiles.length && !metrics.drawCalls)
        throw new Error(`Scene ${name} loaded no geometry from ${scene.chunkFiles.length} chunk file(s)`);
      const screenshot = resolve(outDir, `${name}-${view}.png`);
      const temporary = `${screenshot}.tmp-${process.pid}.png`;
      try {
        await page.screenshot({ path: temporary });
        await rm(screenshot, { force: true });
        await rename(temporary, screenshot);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      results.push({ ...metrics, screenshot, includingScreenshotMs: 0 });
    }
    if (errors.length) throw new Error(errors.join('\n'));

    if (options.manifestPath) {
      const manifestPath = resolve(PROJECT_ROOT, options.manifestPath);
      const current = JSON.parse(await readFile(manifestPath, 'utf8'));
      const dir = resolve(manifestPath, '..');
      const files = [];
      for (const name of await readdir(dir, { recursive: true })) {
        const path = resolve(dir, name);
        if (path !== manifestPath && (await stat(path).catch(() => undefined))?.isFile())
          files.push(await fileRecord(path));
      }
      current.files = files;
      current.validation = { ...current.validation, rendered: true, renderer: 'Three.js WebGL2 + SwiftShader' };
      await atomicWrite(manifestPath, JSON.stringify(current, null, 2));
    }
    return results;
  } finally {
    await browser?.close();
    await new Promise<void>((ready, fail) => server.close((error) => (error ? fail(error) : ready())));
  }
}

function browserScript(base: string, width: number, height: number, background: string) {
  return `
    import * as THREE from '${base}/three/three.module.js';
    const WIDTH = ${width}, HEIGHT = ${height};
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT); renderer.setClearColor('${background}');
    document.body.append(renderer.domElement);

    // Per-vertex block and sky light shaded in the fragment shader; uniforms
    // make the per-scene lighting override instant and geometry uploads untouched.
    // Vertex colors are baked in linear space, so the fragment output encodes
    // to sRGB exactly like the MeshBasicMaterial output path it replaced.
    const SRGB = \`vec3 toSRGB(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,vec3(greaterThanEqual(c,vec3(0.0031308))));}\`;
    const LIGHT_FRAG = \`precision highp float;uniform float uAmbient;uniform float uExposure;uniform float uCurve;uniform float uDay;varying vec3 vColor;varying float vLight;varying float vSky;
      \${SRGB}
      void main(){float l=max(vLight,vSky*uDay);float b=(uAmbient+(1.0-uAmbient)*pow(l,uCurve))*uExposure;gl_FragColor=vec4(toSRGB(vColor*b),1.0);}\`;
    const LIGHT_FRAG_RGBA = \`precision highp float;uniform float uAmbient;uniform float uExposure;uniform float uCurve;uniform float uDay;varying vec4 vColor;varying float vLight;varying float vSky;
      \${SRGB}
      void main(){float l=max(vLight,vSky*uDay);float b=(uAmbient+(1.0-uAmbient)*pow(l,uCurve))*uExposure;gl_FragColor=vec4(toSRGB(vColor.rgb*b),vColor.a);}\`;
    const LIGHT_VERT = \`precision highp float;attribute vec3 position;attribute vec3 color;attribute float light;attribute float sky;
      uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;varying vec3 vColor;varying float vLight;varying float vSky;
      void main(){vColor=color;vLight=light;vSky=sky;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}\`;
    const LIGHT_VERT_RGBA = \`precision highp float;attribute vec3 position;attribute vec4 color;attribute float light;attribute float sky;
      uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;varying vec4 vColor;varying float vLight;varying float vSky;
      void main(){vColor=color;vLight=light;vSky=sky;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}\`;
    const lightingUniforms = (over) => {
      const l = { ambient: 0.18, exposure: 1, curve: 1.45, day: 1, ...(over ?? {}) };
      return {
        uAmbient: { value: l.ambient }, uExposure: { value: l.exposure },
        uCurve: { value: l.curve }, uDay: { value: l.day },
      };
    };
    const opaqueMaterial = new THREE.RawShaderMaterial({
      uniforms: lightingUniforms(), vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG,
    });
    const translucentMaterial = new THREE.RawShaderMaterial({
      uniforms: lightingUniforms(), vertexShader: LIGHT_VERT_RGBA, fragmentShader: LIGHT_FRAG_RGBA,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const applyLighting = (over) => {
      const uniforms = lightingUniforms(over);
      for (const material of [opaqueMaterial, translucentMaterial])
        for (const key of Object.keys(uniforms)) material.uniforms[key].value = uniforms[key].value;
    };

    // Packed chunk format: one file per chunk, decoded by the shared source that
    // also backs the node-side reader. Scenes that differ only by camera share
    // chunk URLs, so decoding is cached and a batched run neither refetches nor
    // re-allocates the same geometry data.
    ${meshChunkDecoderSource()}
    const chunkCache = new Map();
    const unpackChunk = async (url, origin) => {
      const cached = chunkCache.get(url);
      if (cached !== undefined) return cached;
      const response = await fetch(url);
      if (!response.ok) return null;
      const result = decodeMeshChunk(new Uint8Array(await response.arrayBuffer()), origin);
      if (result) chunkCache.set(url, result);
      return result;
    };

    // Geometries belonging to the scene currently on screen, disposed when the
    // next scene replaces them.
    const resident = [];
    const buildGeometry = (positions, colors, alphas, lights, skies) => {      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (alphas) {
        const rgba = new Float32Array(alphas.length * 4);
        for (let i = 0; i < alphas.length; i++) {
          rgba.set(colors.subarray(i * 3, i * 3 + 3), i * 4);
          rgba[i * 4 + 3] = alphas[i];
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
      } else {
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
      // Stale caches without light files read as fully lit, matching the old output.
      let light = lights;
      if (light.length !== positions.length / 3) light = new Float32Array(positions.length / 3).fill(1);
      geometry.setAttribute('light', new THREE.BufferAttribute(light, 1));
      let sky = skies;
      if (sky.length !== positions.length / 3) sky = new Float32Array(positions.length / 3).fill(1);
      geometry.setAttribute('sky', new THREE.BufferAttribute(sky, 1));
      return geometry;
    };

    window.renderScene = async ({ name, view, scene }) => {
      const start = performance.now();
      applyLighting(scene.lighting);
      // One scene is resident at a time: a batched run would otherwise keep every
      // view's GPU buffers alive at once and could exhaust the renderer.
      for (const geometry of resident) geometry.dispose();
      resident.length = 0;
      const group = new THREE.Scene();
      const geometries = resident;
      for (const prefix of scene.chunkFiles) {
        // Positions are chunk-local, so the reader needs the chunk's world origin.
        const chunk = await unpackChunk('${base}/' + prefix + '.bin', chunkOriginFor(prefix));
        if (!chunk) continue;
        const { positions, colors, lights, skies } = chunk;
        if (positions.length) {
          const geometry = buildGeometry(positions, colors, null, lights, skies);
          geometries.push(geometry); group.add(new THREE.Mesh(geometry, opaqueMaterial));
        }
        const translucent = chunk.translucentPositions;
        if (translucent.length) {
          const geometry = buildGeometry(translucent, chunk.translucentColors, chunk.translucentAlphas, chunk.translucentLights, chunk.translucentSkies);
          geometries.push(geometry); group.add(new THREE.Mesh(geometry, translucentMaterial));
        }
      }
      const bounds = scene.bounds;
      const center = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(0.5);
      const directions = { iso: [1, 0.85, 1], front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, 0] };
      const camera = scene.eye
        ? new THREE.PerspectiveCamera(65, WIDTH / HEIGHT, 0.1, 100000)
        : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
      if (view === 'top') camera.up.set(0, 0, -1);
      camera.position.copy(center).add(new THREE.Vector3(...(scene.direction ?? directions[view] ?? directions.iso)).normalize().multiplyScalar(20000));
      camera.lookAt(center); camera.updateMatrixWorld(true);

      let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
      const project = (point) => {
        point.applyMatrix4(camera.matrixWorldInverse);
        loX = Math.min(loX, point.x); hiX = Math.max(hiX, point.x);
        loY = Math.min(loY, point.y); hiY = Math.max(hiY, point.y);
      };
      if (scene.fit === 'geometry') {
        const scratch = new THREE.Vector3();
        for (const geometry of geometries) {
          const position = geometry.getAttribute('position');
          for (let i = 0; i < position.count; i++) project(scratch.fromBufferAttribute(position, i));
        }
      } else {
        for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) project(new THREE.Vector3(x, y, z));
      }
      const half = Math.max((hiY - loY) / 2, (hiX - loX) / 2 / (WIDTH / HEIGHT), 0.5) * 1.16;
      const cx = scene.fit === 'geometry' ? (loX + hiX) / 2 : 0;
      const cy = scene.fit === 'geometry' ? (loY + hiY) / 2 : 0;
      camera.left = cx - half * WIDTH / HEIGHT; camera.right = cx + half * WIDTH / HEIGHT;
      camera.top = cy + half; camera.bottom = cy - half; camera.updateProjectionMatrix();

      document.querySelectorAll('.preview-label').forEach(node => node.remove());
      const label = (text, css) => { const node = document.createElement('div'); node.className = 'preview-label'; node.textContent = text; node.style.cssText = css; document.body.append(node); };
      if (scene.title) label(scene.title, 'position:absolute;top:24px;left:32px;color:#12324a;font:20px Segoe UI,sans-serif');
      const placeholders = (scene.diagnostics ?? []).reduce((total, item) => total + item.count, 0);
      if (placeholders) label('PLACEHOLDER: ' + placeholders + ' cells / magenta cross = unsupported geometry', 'position:absolute;top:54px;left:32px;color:#c026a8;font:18px Segoe UI,sans-serif');
      if (scene.legend?.length) {
        const legend = document.createElement('div');
        legend.className = 'preview-label';
        legend.style.cssText = 'position:absolute;bottom:20px;left:32px;right:32px;display:flex;gap:18px;flex-wrap:wrap;color:#25405a;font:15px Segoe UI,sans-serif';
        for (const entry of scene.legend) {
          const item = document.createElement('span');
          const swatch = document.createElement('i');
          swatch.style.cssText = 'display:inline-block;width:13px;height:13px;margin-right:7px;border:1px solid #8094a5;background:' + entry.color;
          item.append(swatch, document.createTextNode(entry.name));
          legend.append(item);
        }
        document.body.append(legend);
      }
      if (scene.eye) { camera.position.set(...scene.eye); camera.lookAt(new THREE.Vector3(...(scene.target ?? bounds.min))); camera.updateMatrixWorld(true); }

      const markerMaterials = [];
      for (const marker of scene.markers ?? []) {
        const lo = marker.bounds.min, hi = marker.bounds.max;
        const box = new THREE.BoxGeometry(hi[0]-lo[0]+0.06, hi[1]-lo[1]+0.06, hi[2]-lo[2]+0.06);
        const geometry = new THREE.EdgesGeometry(box); box.dispose();
        const material = new THREE.LineBasicMaterial({ color: marker.color, depthTest: false, depthWrite: false });
        const lines = new THREE.LineSegments(geometry, material);
        lines.position.set((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2);
        lines.renderOrder = 1000; group.add(lines);
        geometries.push(geometry); markerMaterials.push(material);
      }

      renderer.render(group, camera);
      renderer.getContext().finish();
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const result = {
        name, view,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        fetchUploadRenderMs: performance.now() - start,
        device: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
      geometries.forEach(geometry => geometry.dispose());
      markerMaterials.forEach(material => material.dispose());
      return result;
    };
  `;
}
