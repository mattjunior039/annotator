import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, link, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const usage = 'npm run benchmark:browser -- [--count 10000] [--size reference|compact] [--batch 100] [--edits 50] [--navigation 30] [--budget-seconds 1800] [--port 4187]';
const options = { count: 10000, size: 'reference', batch: 100, edits: 50, navigation: 30, 'budget-seconds': 1800, port: 4187 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in options) || process.argv[i + 1] === undefined) throw new Error(usage);
  options[key] = key === 'size' ? process.argv[i + 1] : Number(process.argv[i + 1]);
}
for (const key of ['count', 'batch', 'edits', 'navigation', 'budget-seconds', 'port']) {
  if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(usage);
}
if (options.count > 10000 || options.batch > 100 || options.edits > 200 || options.navigation > 200
  || options.port > 65535 || !['reference', 'compact'].includes(options.size)) throw new Error(usage);

const directory = resolve('benchmarks/generated', `browser-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
await mkdir(directory, { recursive: false });
await mkdir(join(directory, 'runtime'));
// Keep browser profiles, crash files, and automation scratch data inside this run.
process.env.TMPDIR = join(directory, 'runtime');
const report = {
  version: 1, startedAt: new Date().toISOString(), status: 'running', options,
  environment: {
    node: process.version, os: `${os.type()} ${os.release()}`, architecture: os.arch(),
    cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, hostRamBytes: os.totalmem(),
    headless: true, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
    state: 'fresh isolated browser profile and origin; production build; no application storage seeding',
    sharp: sharp.versions,
  },
  intake: { batches: [], committedImages: 0 }, resources: [], edits: [], errors: [], network: { requests: 0, blockedExternal: [] },
  limitations: [
    'Synthetic, highly compressible bands only; not representative of photographs, high entropy, quota exhaustion, or all browsers.',
    'Batched UI intake includes file selection, automation, sanitization, encrypted persistence, and catalog rendering; not a single 10000-file picker operation.',
    'First-image readiness is the first decoded editor image after the first batch, not readiness while intake is running.',
    'Input-render is trusted click to two animation frames after the label DOM mutation: a presentation opportunity proxy, not hardware input-to-photon or continuous pointer-drag latency.',
    'Commit acknowledgement is observed at the worker protocol boundary, not fsync/power-loss durability; input-to-ack also includes UI scheduling.',
    'JS heap and DOM counters cover the main renderer only. Worker/WASM, decoded bitmaps, GPU, browser process, and total process memory are not measured. The 768 MiB total-memory gate cannot be certified.',
    'Object URL accounting covers the main window only; live worker count is not worker memory. Catalog count is validated through successful intake acknowledgements and end-of-catalog search, not an internal memory census.',
    'Resource snapshots are sampled, not continuous peak-memory measurements. Instrumentation and automation add overhead. Timing gate results describe this run only.',
  ],
};
const save = async () => {
  const pending = join(directory, `report-${randomUUID()}.pending`);
  await writeFile(pending, JSON.stringify(report, null, 2), { flag: 'wx' });
  await rename(pending, join(directory, 'report.json'));
};
await save();
console.log(`Benchmark run: ${directory}`);
let browser, context, server, deadline;
const start = performance.now();
let timedOut = false;
const assert = (value, message) => { if (!value) throw new Error(message); };
const quantile = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const command = (args, log) => new Promise((done, fail) => {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-24000); });
  child.stderr.on('data', data => { output = (output + data).slice(-24000); });
  child.on('error', fail);
  child.on('close', async code => {
    try {
      await writeFile(join(directory, log), output, { flag: 'wx' });
      code === 0 ? done() : fail(new Error(`${args.join(' ')} exited ${code}; see ${log}`));
    } catch (error) { fail(error); }
  });
});
try {
  await command(['node_modules/typescript/bin/tsc', '-b'], 'typecheck.log');
  await command(['node_modules/vite/bin/vite.js', 'build'], 'build.log');
  const distFiles = [];
  async function fingerprint(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await fingerprint(join(path, entry.name), `${name}/`);
      else {
        const bytes = await readFile(join(path, entry.name));
        distFiles.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await fingerprint(resolve('dist'));
  report.environment.productionFiles = distFiles;
  const width = options.size === 'reference' ? 2048 : 256;
  const height = options.size === 'reference' ? 1536 : 192;
  const fixtureDirectory = join(directory, 'fixtures');
  await mkdir(fixtureDirectory);
  const pool = [];
  let totalEncodedBytes = 0;
  // The reference algorithm repeats every 256 seeds. Hard links preserve the
  // exact corpus pixels/names without 10000 encoded buffers or full raw images.
  for (let index = 0; index < Math.min(options.count, 256); index++) {
    const seed = index + 1, pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (Math.floor(x / 64) * 17 + seed) % 256;
      pixels[offset + 1] = (Math.floor(y / 64) * 23 + seed * 7) % 256;
      pixels[offset + 2] = (Math.floor((x + y) / 128) * 31 + seed * 11) % 256;
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    const name = `synthetic-${String(index).padStart(5, '0')}.png`;
    await writeFile(join(fixtureDirectory, name), png, { flag: 'wx' });
    pool.push({ seed, name, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
  }
  for (let index = 0; index < options.count; index++) {
    const entry = pool[index % 256];
    totalEncodedBytes += entry.bytes;
    if (index >= 256) await link(join(fixtureDirectory, entry.name), join(fixtureDirectory, `synthetic-${String(index).padStart(5, '0')}.png`));
  }
  report.fixture = {
    generator: options.size === 'reference' ? 'synthetic-bands-v1' : 'synthetic-bands-v1-compact',
    width, height, count: options.count, totalEncodedBytes, pool,
    names: 'synthetic-{index padded to 5 digits}.png; seed=index+1; pixel channels periodic modulo 256',
    generation: 'one raw image at a time; up to 256 encoded disk images; remaining names are hard links; UI selects at most 100 paths per batch',
  };
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(report.fixture, null, 2), { flag: 'wx' });
  await save();
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(options.port), '--strictPort'],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '', serverFailed = false;
  server.stdout.on('data', data => { serverOutput = (serverOutput + data).slice(-8000); });
  server.stderr.on('data', data => { serverOutput = (serverOutput + data).slice(-8000); });
  server.on('error', () => { serverFailed = true; });
  server.on('exit', () => { serverFailed = true; });
  const origin = `http://127.0.0.1:${options.port}`;
  for (let attempt = 0; ; attempt++) {
    assert(!serverFailed && attempt < 100, `Preview failed: ${serverOutput}`);
    await new Promise(done => setTimeout(done, 100));
    try { if ((await fetch(origin)).ok) break; } catch { /* Server is starting. */ }
  }
  // Do not accidentally attach to an older server that occupied this port.
  await new Promise(done => setTimeout(done, 200));
  assert(!serverFailed, `Preview failed: ${serverOutput}`);
  const { chromium, expect } = await import('@playwright/test');
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    headless: true, viewport: report.environment.viewport, deviceScaleFactor: 1,
    acceptDownloads: false, env: { ...process.env, TMPDIR: process.env.TMPDIR },
  });
  browser = context.browser();
  report.environment.browser = browser.version();
  await context.route('**/*', route => {
    const url = route.request().url();
    report.network.requests++;
    if (new URL(url).origin !== origin) {
      report.network.blockedExternal.push(url.slice(0, 200));
      return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const state = window.__benchmark = {
      imports: 0, failedImports: 0, requests: {}, activeUrls: 0, maxUrls: 0, createdUrls: 0, revokedUrls: 0,
      edits: [], armed: false, current: null,
    };
    const urls = new Set();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => {
      const url = create(object);
      urls.add(url); state.createdUrls++; state.activeUrls = urls.size;
      state.maxUrls = Math.max(state.maxUrls, urls.size);
      return url;
    };
    URL.revokeObjectURL = url => {
      urls.delete(url); state.revokedUrls++; state.activeUrls = urls.size;
      return revoke(url);
    };
    const observed = new WeakSet(), pending = new WeakMap(), post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (!observed.has(this)) {
        observed.add(this); pending.set(this, new Map());
        this.addEventListener('message', event => {
          const requests = pending.get(this), request = requests.get(event.data?.id);
          if (!request) return;
          requests.delete(event.data.id);
          if (request.type === 'workspace-import') {
            if (event.data.ok) state.imports++; else state.failedImports++;
          }
          if (request.type === 'workspace-update' && request.edit) {
            request.edit.ok = event.data.ok;
            request.edit.requestToAckMs = performance.now() - request.started;
            request.edit.inputToAckMs = performance.now() - request.edit.inputAt;
          }
        });
      }
      const type = message?.payload?.type;
      state.requests[type] = (state.requests[type] ?? 0) + 1;
      pending.get(this).set(message?.id, { type, started: performance.now(), edit: type === 'workspace-update' ? state.current : null });
      return post.call(this, message, ...args);
    };
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!state.armed || !event.isTrusted || !['class_0', '✓ class_0'].includes(button?.textContent?.trim())) return;
      state.current = { inputAt: performance.now(), expectedLabel: button.textContent.trim() === 'class_0' };
      state.edits.push(state.current);
    }, true);
    new MutationObserver(() => {
      const edit = state.current;
      if (!edit || edit.renderScheduled) return;
      const present = [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'class_0 · label');
      if (present !== edit.expectedLabel) return;
      edit.renderScheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { edit.inputToRenderOpportunityMs = performance.now() - edit.inputAt; }));
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => report.errors.push(String(error)));
  const workers = new Set();
  page.on('worker', worker => { workers.add(worker); worker.on('close', () => workers.delete(worker)); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const snapshot = async label => {
    const data = await page.evaluate(async () => ({
      galleryItems: document.querySelectorAll('.gallery-item').length,
      catalogResultItems: document.querySelectorAll('.image-file').length,
      htmlImages: document.querySelectorAll('img').length,
      svgImages: document.querySelectorAll('svg image').length,
      canvases: document.querySelectorAll('canvas').length,
      annotationCanvases: document.querySelectorAll('svg.annotation-canvas').length,
      objectUrls: { active: window.__benchmark.activeUrls, peak: window.__benchmark.maxUrls, created: window.__benchmark.createdUrls, revoked: window.__benchmark.revokedUrls },
      storageEstimate: await navigator.storage.estimate(),
    }));
    const metrics = await cdp.send('Performance.getMetrics');
    const dom = await cdp.send('Memory.getDOMCounters');
    const sample = { label, elapsedMs: performance.now() - start, ...data, liveWorkers: workers.size, mainRendererDom: dom,
      mainRendererJsHeapUsedBytes: metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null };
    report.resources.push(sample);
    assert(data.galleryItems <= 100 && data.catalogResultItems <= 100, `Unbounded rendered catalog at ${label}`);
    assert(data.annotationCanvases <= 1 && data.htmlImages + data.svgImages <= 4 && data.objectUrls.active <= 4 && workers.size <= 2,
      `Rendered media/URL/worker resource bound exceeded at ${label}`);
    return sample;
  };
  deadline = setTimeout(() => { timedOut = true; void context.close().catch(() => {}); }, options['budget-seconds'] * 1000);
  await page.goto(origin);
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Synthetic resource benchmark');
  await page.getByLabel('Password protect this workspace', { exact: true }).check();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill('synthetic-only benchmark passphrase');
  await page.getByLabel('Confirm workspace passphrase', { exact: true }).fill('synthetic-only benchmark passphrase');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Encrypted backup', exact: true })).toBeEnabled();
  const intakeStart = performance.now();
  for (let offset = 0; offset < options.count; offset += options.batch) {
    const count = Math.min(options.batch, options.count - offset);
    const paths = Array.from({ length: count }, (_, i) => join(fixtureDirectory, `synthetic-${String(offset + i).padStart(5, '0')}.png`));
    const batchStart = performance.now();
    await page.getByLabel('Add images', { exact: true }).setInputFiles(paths);
    await expect.poll(() => page.evaluate(() => window.__benchmark.imports), { timeout: options['budget-seconds'] * 1000 }).toBe(offset + count);
    await expect(page.getByText(`Import finished · ${count} added`, { exact: false })).toBeVisible();
    const wallMs = performance.now() - batchStart;
    report.intake.batches.push({ offset, count, wallMs, imagesPerSecond: count * 1000 / wallMs });
    report.intake.committedImages = offset + count;
    if (offset === 0) {
      const readyStart = performance.now();
      await page.locator('.gallery-open').first().click();
      await expect(page.locator('svg.annotation-canvas image')).toBeVisible();
      await page.locator('svg.annotation-canvas image').evaluate(async element => {
        const image = new Image(); image.src = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        await image.decode();
      });
      report.intake.firstImageReadyMs = performance.now() - intakeStart;
      report.intake.firstImageEditorOpenAndDecodeMs = performance.now() - readyStart;
      await snapshot('first-image-ready');
      await page.getByRole('button', { name: 'Dataset', exact: true }).click();
    }
    if (offset === 0 || (offset + count) % 1000 === 0 || offset + count === options.count) {
      console.log(`Committed ${offset + count}/${options.count} (${wallMs.toFixed(0)} ms last batch)`);
      await snapshot(`intake-${offset + count}`);
      await save();
    }
  }
  report.intake.wallMs = performance.now() - intakeStart;
  report.intake.imagesPerSecond = options.count * 1000 / report.intake.wallMs;
  report.intake.batchWorkMs = report.intake.batches.reduce((sum, batch) => sum + batch.wallMs, 0);
  report.intake.batchWorkImagesPerSecond = options.count * 1000 / report.intake.batchWorkMs;
  // Search the last filename, then exercise the complete catalog in the editor.
  const lastName = `synthetic-${String(options.count - 1).padStart(5, '0')}.png`;
  await page.getByLabel('Search images', { exact: true }).fill(lastName);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: `${lastName} annotation canvas`, exact: true })).toBeVisible();
  await page.getByLabel('Search images', { exact: true }).fill('synthetic-');
  await page.getByRole('button', { name: 'Image labels', exact: true }).click();
  await page.evaluate(() => { window.__benchmark.armed = true; });
  for (let index = 0; index < options.edits; index++) {
    await page.getByRole('button', { name: index % 2 ? '✓ class_0' : 'class_0', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const edit = window.__benchmark.edits.at(-1);
      return Boolean(edit?.ok && edit.inputToRenderOpportunityMs !== undefined);
    })).toBe(true);
    await expect(page.locator('.save-indicator')).toContainText('Saved on this device');
  }
  report.edits = await page.evaluate(() => window.__benchmark.edits);
  assert(report.edits.length === options.edits, 'Missing trusted input edit samples');
  report.latency = {
    samples: report.edits.length,
    p95RequestToCommitAckMs: quantile(report.edits.map(edit => edit.requestToAckMs)),
    p95InputToCommitAckMs: quantile(report.edits.map(edit => edit.inputToAckMs)),
    p95InputToRenderOpportunityMs: quantile(report.edits.map(edit => edit.inputToRenderOpportunityMs)),
    percentileMethod: 'nearest rank, ceil(0.95*N), no discarded warm-up samples',
  };
  await page.evaluate(() => { window.__benchmark.armed = false; });
  // Alternating distant search results exercises catalog queries and media URL
  // replacement rather than merely revisiting already mounted neighbors.
  for (let index = 0; index < options.navigation; index++) {
    const imageIndex = index % 2 ? options.count - 1 : Math.floor(index * (options.count - 1) / options.navigation);
    const name = `synthetic-${String(imageIndex).padStart(5, '0')}.png`;
    await page.getByLabel('Search images', { exact: true }).fill(name);
    await expect(page.locator('.image-file')).toHaveCount(1);
    await page.locator('.image-file').click();
    await expect(page.getByRole('img', { name: `${name} annotation canvas`, exact: true })).toBeVisible();
    await page.getByLabel('Search images', { exact: true }).fill('synthetic-');
    await expect(page.locator('.image-file')).toHaveCount(Math.min(options.count, 100));
    await snapshot(`navigation-${index + 1}`);
  }
  report.instrumentation = await page.evaluate(() => ({
    imports: window.__benchmark.imports, failedImports: window.__benchmark.failedImports, requests: window.__benchmark.requests,
  }));
  assert(report.instrumentation.imports === options.count && report.instrumentation.failedImports === 0, 'Intake count mismatch');
  await page.reload();
  await page.locator('.workspace-tile').click();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill('synthetic-only benchmark passphrase');
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByLabel('Search images', { exact: true }).fill(lastName);
  await expect(page.locator('.gallery-item')).toHaveCount(1);
  await page.locator('.gallery-open').click();
  await expect(page.getByRole('img', { name: `${lastName} annotation canvas`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'class_0 · label', exact: true })).toHaveCount(options.edits % 2);
  await snapshot('reloaded-last-image');
  const navigation = report.resources.filter(sample => sample.label.startsWith('navigation-'));
  const firstNavigation = navigation[0], lastNavigation = navigation.at(-1);
  const noRetainedHandleGrowth = lastNavigation.objectUrls.active <= firstNavigation.objectUrls.active
    && lastNavigation.liveWorkers <= firstNavigation.liveWorkers;
  report.gates = {
    fullReferenceWorkload: options.count === 10000 && options.size === 'reference',
    committedCatalogCount: report.intake.committedImages,
    persistedTailImageAndFinalEditAfterReload: true,
    sampledRenderedResourcesWithinBounds: true,
    renderedBounds: { galleryItems: 100, catalogResultItems: 100, annotationCanvases: 1, mediaElements: 4, mainWindowObjectUrls: 4, liveWorkers: 2 },
    navigationActiveUrls: navigation.map(sample => sample.objectUrls.active),
    navigationLiveWorkers: navigation.map(sample => sample.liveWorkers),
    noEndpointGrowthInSampledNavigationUrlsOrWorkers: noRetainedHandleGrowth,
    commitAckP95Below250Ms: report.latency.p95InputToCommitAckMs < 250,
    renderOpportunityP95Below50Ms: report.latency.p95InputToRenderOpportunityMs < 50,
    totalProcessMemoryBelow768MiB: null,
    pointerDragP95Below50Ms: null,
    releaseCertification: false,
  };
  assert(report.errors.length === 0 && report.network.blockedExternal.length === 0, 'Runtime errors or external requests occurred');
  report.status = 'completed';
} catch (error) {
  report.status = timedOut ? 'budget-exhausted' : 'failed';
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (context) await context.close().catch(error => report.errors.push(String(error)));
  if (server && server.exitCode === null) {
    const stopped = new Promise(done => server.once('exit', done));
    server.kill('SIGTERM');
    await Promise.race([stopped, new Promise(done => setTimeout(done, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  // Preserve raw results/fixture hashes, not a growing collection of profiles.
  await rm(join(directory, 'profile'), { recursive: true, force: true });
  await rm(join(directory, 'runtime'), { recursive: true, force: true });
  await rm(join(directory, 'fixtures'), { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.totalWallMs = performance.now() - start;
  await save();
  console.log(JSON.stringify({ report: join(directory, 'report.json'), status: report.status, committedImages: report.intake.committedImages, latency: report.latency, errors: report.errors }));
}
