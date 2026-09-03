// Read-only gallery stress run. Grid thumbnails come from Windows Shell's cache.
// Start myvault-webviews with MYVAULT_WEBVIEW_TEST_DEBUG=1 first.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, '.test-data', 'single-window', 'gallery-stress');
const cachedRun = process.argv.includes('--cached');
const thumbnailsOnly = process.argv.includes('--thumbnails-only');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${last || check.toString()}`);
}

async function connect(port) {
  const version = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? response.json() : null;
  });
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const page = await until(() => browser.contexts().flatMap(context => context.pages())[0]);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  return { browser, page };
}

function processSnapshot(name) {
  const command = `$all = @(Get-CimInstance Win32_Process); $roots = @($all | Where-Object { $_.Name -eq 'myvault-webviews.exe' }); $ids = [System.Collections.Generic.HashSet[int]]::new(); foreach ($p in $roots) { [void]$ids.Add($p.ProcessId) }; do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); $result = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*single-window*WebViews*') } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [PSCustomObject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; command=$_.CommandLine; workingSet=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64 } } }); ConvertTo-Json -InputObject $result -Compress`;
  const raw = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }));
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const galleryRows = rows.filter(row => row.command && row.command.includes('WebViews\\gallery'));
  const summary = {
    name,
    timestamp: new Date().toISOString(),
    totalProcesses: rows.length,
    totalWorkingSet: rows.reduce((sum, row) => sum + row.workingSet, 0),
    totalPrivateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0),
    galleryProcesses: galleryRows.length,
    galleryWorkingSet: galleryRows.reduce((sum, row) => sum + row.workingSet, 0),
    galleryPrivateBytes: galleryRows.reduce((sum, row) => sum + row.privateBytes, 0),
    rows,
  };
  console.log(JSON.stringify({ ...summary, rows: undefined }));
  return summary;
}

const invoke = (page, command, args = {}) => page.evaluate(
  ([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), thumbnailsOnly, samples: [], errors: [] };
  const shell = await connect(9330);
  shell.page.on('pageerror', error => report.errors.push(`shell: ${error}`));
  assert.equal(await invoke(shell.page, 'get_module_host_mode'), true);
  await shell.page.waitForFunction(() => document.querySelectorAll('.module-tab:not(:disabled)').length === 4);
  report.samples.push(processSnapshot('notes-baseline'));

  const openStarted = performance.now();
  await shell.page.locator('.module-tab').nth(3).click();
  const gallery = await connect(9332);
  gallery.page.on('pageerror', error => report.errors.push(`gallery: ${error}`));
  await gallery.page.waitForSelector('.gallery-card', { timeout: 120000 });
  await until(async () => await gallery.page.locator('.gallery-loading').count() === 0, 120000);
  report.openMilliseconds = Math.round(performance.now() - openStarted);
  const counter = await gallery.page.locator('.gallery-pagination div span').innerText();
  report.totalPages = Number(counter.split('/')[1].trim());
  report.totalItems = Number((await gallery.page.locator('.gallery-heading p').innerText()).match(/\d+/)?.[0]);
  assert.ok(report.totalItems >= 700, `Expected at least 700 pictures, got ${report.totalItems}`);

  for (let pageNumber = 1; pageNumber <= report.totalPages; pageNumber++) {
    if (thumbnailsOnly) {
      const cards = gallery.page.locator('.gallery-card');
      for (let index = 0; index < await cards.count(); index += 8) {
        await cards.nth(index).scrollIntoViewIfNeeded();
      }
      await cards.last().scrollIntoViewIfNeeded();
      await gallery.page.waitForFunction(() => [...document.querySelectorAll('.gallery-card img')]
        .every(image => image.complete && image.naturalWidth > 0), null, { timeout: 120000 });
    } else {
      await gallery.page.locator('.gallery-card').first().click();
      const preview = gallery.page.locator('.gallery-preview > img');
      await preview.waitFor();
      await preview.evaluate(image => image.decode());
      await gallery.page.getByRole('button', { name: '关闭预览' }).click();
    }
    if (pageNumber === 1 || pageNumber % 4 === 0 || pageNumber === report.totalPages) {
      report.samples.push(processSnapshot(`gallery-page-${pageNumber}`));
    }
    if (pageNumber < report.totalPages) {
      await gallery.page.getByRole('button', { name: '下一页' }).click();
      await until(async () => await gallery.page.locator('.gallery-loading').count() === 0, 120000);
      await gallery.page.waitForFunction(expected =>
        document.querySelector('.gallery-pagination div span')?.textContent?.trim().startsWith(`${expected} /`), pageNumber + 1);
    }
  }
  await gallery.page.screenshot({ path: path.join(output, 'last-page.png') });
  const galleryPids = report.samples.at(-1).rows
    .filter(row => row.command && row.command.includes('WebViews\\gallery')).map(row => row.pid);

  const closeStarted = performance.now();
  await shell.page.locator('.module-tab').nth(0).click();
  await until(() => !processSnapshot('close-poll').rows.some(row => galleryPids.includes(row.pid)), 30000);
  report.closeMilliseconds = Math.round(performance.now() - closeStarted);
  const closeSamples = cachedRun
    ? [['after-close-2s', 2000], ['after-close-5s', 3000]]
    : [['after-close-2s', 2000], ['after-close-5s', 3000], ['after-close-15s', 10000], ['after-close-30s', 15000]];
  for (const [label, delay] of closeSamples) {
    await sleep(delay);
    report.samples.push(processSnapshot(label));
  }
  assert.equal(report.samples.at(-1).galleryProcesses, 0);
  assert.deepEqual(report.errors, []);
  report.finishedAt = new Date().toISOString();
  const reportName = thumbnailsOnly
    ? 'shell-thumbnails-report.json'
    : cachedRun ? 'warm-report.json' : 'cold-report.json';
  fs.writeFileSync(path.join(output, reportName), JSON.stringify(report, null, 2));
  await invoke(shell.page, 'close_window').catch(() => {});
  await gallery.browser.close().catch(() => {});
  await shell.browser.close().catch(() => {});
  console.log(`PASS: ${report.totalItems} pictures, ${report.totalPages} pages, gallery group fully exited`);
})().catch(error => { console.error(error); process.exit(1); });
