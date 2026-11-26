import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Explicit opt-in: requires a built CLI and an installed Chromium browser.
test(
  'live browser reloads helpers, preserves camera and GPU objects, and recovers from errors',
  { skip: !process.env.BLOCKWRIGHT_LIVE_BROWSER_TEST, timeout: 90_000 },
  async () => {
    const parent = resolve('cache');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'live-preview-test-'));
    const building = join(root, 'live-fixture');
    await mkdir(building);
    await writeFile(
      join(building, 'blockwright.building.json'),
      JSON.stringify({ schemaVersion: 1, id: 'live-fixture', name: 'Live fixture', entry: './building.mjs' }),
    );
    await writeFile(
      join(building, 'building.mjs'),
      `import {defineBuilding,Structure,block} from 'bewright';
import {material} from './helper.mjs';
export default defineBuilding({id:'live-fixture',name:'Live fixture',bounds:{min:[0,0,0],max:[112,16,16]},views:[{name:'near',eye:[5,5,5],target:[0,0,0]},{name:'far',eye:[100,5,5],target:[96,0,0]},{name:'slice',region:{min:[0,0,0],max:[16,16,16]}}],build(){const s=new Structure();s.set(0,0,0,block(material));s.set(96,0,0,block('glass'));return s;}});`,
    );
    const helper = join(building, 'helper.mjs');
    await writeFile(helper, `export const material='stone';`);
    const child = spawn(
      process.execPath,
      ['dist/cli/index.js', 'preview', 'live-fixture', '--content', root, '--watch'],
      { windowsHide: true },
    );
    let log = '';
    child.stdout.on('data', (data) => {
      log += data;
    });
    child.stderr.on('data', (data) => {
      log += data;
    });
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.BLOCKWRIGHT_BROWSER_CHANNEL ?? 'chrome',
      args: ['--enable-unsafe-swiftshader'],
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!/http:\/\/127\.0\.0\.1:\d+\//.test(log)) {
        assert.ok(Date.now() < deadline, log);
        await new Promise((accept) => setTimeout(accept, 50));
      }
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => (window as any).blockwrightPreview?.revision >= 1);
      await page.evaluate(() => {
        const p = (window as any).blockwrightPreview;
        (window as any).originalGroup = p.chunks.get('6,0,0').group;
        p.camera.position.set(40, 30, 60);
        p.controls.target.set(1, 2, 3);
        p.controls.update();
      });
      await writeFile(helper, `export const material='gold_block';`);
      await page.waitForFunction(() => (window as any).blockwrightPreview.revision >= 2);
      const retained = await page.evaluate(() => {
        const p = (window as any).blockwrightPreview;
        return {
          same: p.chunks.get('6,0,0').group === (window as any).originalGroup,
          eye: p.camera.position.toArray(),
          target: p.controls.target.toArray(),
        };
      });
      assert.equal(retained.same, true);
      assert.deepEqual(retained.target, [1, 2, 3]);
      retained.eye.forEach((value: number, index: number) => assert.ok(Math.abs(value - [40, 30, 60][index]) < 1e-9));
      const state = await fetch(url + 'state').then((r) => r.json());
      assert.equal(state.metrics.rebuilt, 1);
      const before = await page.evaluate(() => (window as any).blockwrightPreview.revision);
      await writeFile(helper, 'this is invalid syntax!');
      await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('构建失败'));
      assert.equal(await page.evaluate(() => (window as any).blockwrightPreview.revision), before);
      await writeFile(helper, `export const material='stone';`);
      await page.waitForFunction((previous) => (window as any).blockwrightPreview.revision > previous, before);
      await page.reload();
      await page.waitForFunction(() => (window as any).blockwrightPreview?.revision > 0);
      const eye = await page.evaluate(() => (window as any).blockwrightPreview.camera.position.toArray());
      eye.forEach((value: number, index: number) => assert.ok(Math.abs(value - [40, 30, 60][index]) < 1e-9));
      const beforeSwitch = await page.evaluate(() => {
        (window as any).retainedGroup = (window as any).blockwrightPreview.chunks.get('6,0,0').group;
        return (window as any).blockwrightPreview.revision;
      });
      await page.selectOption('#views', 'view:far');
      assert.equal(await page.locator('#views option[value="view:slice"]').isDisabled(), true);
      const far = await page.evaluate(() => (window as any).blockwrightPreview.camera.position.toArray());
      far.forEach((value: number, index: number) => assert.ok(Math.abs(value - [100, 5, 5][index]) < 1e-9));
      assert.equal(await page.evaluate(() => (window as any).blockwrightPreview.revision), beforeSwitch);
      assert.equal(
        await page.evaluate(
          () => (window as any).blockwrightPreview.chunks.get('6,0,0').group === (window as any).retainedGroup,
        ),
        true,
      );
      await page.fill('#bookmark-name', '走廊检查');
      await page.click('#bookmark');
      await page.reload();
      await page.waitForFunction(() => (window as any).blockwrightPreview?.revision > 0);
      assert.equal(await page.locator('#views option[value="saved:0"]').textContent(), '走廊检查');
      await page.click('#tour');
      assert.equal(await page.locator('#tour').textContent(), '停止巡览');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#tour').textContent(), '开始巡览');
      await page.locator('canvas').click({ position: { x: 600, y: 500 } });
      const startMove = await page.evaluate(() => (window as any).blockwrightPreview.camera.position.toArray());
      await page.keyboard.down('w');
      await page.waitForTimeout(180);
      await page.keyboard.up('w');
      const endMove = await page.evaluate(() => (window as any).blockwrightPreview.camera.position.toArray());
      assert.ok(endMove.some((value: number, index: number) => Math.abs(value - startMove[index]) > 0.1));
      await page.click('#support summary');
      assert.match(await page.locator('#support-table').innerText(), /Java 转换/);
      assert.equal((await fetch(url + 'state').then((r) => r.json())).support.length, 2);
      await page.locator('#support-table button').first().click();
      const focused = await page.evaluate(() => (window as any).blockwrightPreview.controls.target.toArray());
      assert.deepEqual(focused, [0.5, 0.5, 0.5]);
      assert.deepEqual(errors, []);
      assert.equal((await fetch(url + '../../../package.json')).status, 404);
    } finally {
      await browser.close();
      child.kill();
      await new Promise<void>((accept) => {
        if (child.exitCode !== null) accept();
        else child.once('exit', () => accept());
      });
      // mkdtemp returns a checked absolute child of our own cache directory.
      assert.equal(resolve(root).startsWith(parent + '\\') || resolve(root).startsWith(parent + '/'), true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
