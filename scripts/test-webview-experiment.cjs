// Requires Playwright on NODE_PATH and the experimental executable started with
// MYVAULT_WEBVIEW_TEST_DEBUG=1. Never attaches to the installed MyVault instance.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');
const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, '.test-data', 'single-window', 'verification');
const cycles = Math.max(1, Math.min(50, Number(process.env.MYVAULT_TEST_CYCLES) || 5));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${last || check.toString()}`);
}

function processes() {
  const command = `$all = @(Get-CimInstance Win32_Process); $roots = @($all | Where-Object { $_.Name -eq 'myvault-webviews.exe' }); $ids = [System.Collections.Generic.HashSet[int]]::new(); foreach ($p in $roots) { [void]$ids.Add($p.ProcessId) }; do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); $result = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*single-window*WebViews*') } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [PSCustomObject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; command=$_.CommandLine; workingSet=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64 } } }); ConvertTo-Json -InputObject $result -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }));
}

async function connect(port) {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).ok);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const page = await until(() => browser.contexts().flatMap(c => c.pages())[0]);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  return { browser, page };
}

const invoke = (page, command, args = {}) => page.evaluate(
  ([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args), [command, args]);

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = { samples: [], errors: [] };
  const shell = await connect(9330);
  shell.page.on('pageerror', error => report.errors.push(String(error)));
  shell.page.on('dialog', async dialog => { report.errors.push(`Unexpected dialog: ${dialog.message()}`); await dialog.dismiss(); });
  assert.equal(await invoke(shell.page, 'get_module_host_mode'), true);
  await shell.page.waitForFunction(() => document.querySelectorAll('.module-tab:not(:disabled)').length === 4);
  const boot = await invoke(shell.page, 'bootstrap_app');
  assert.match(boot.vaultPath.replaceAll('\\', '/'), /\.test-data\/single-window\/MyVaultData/);
  const sample = (name) => {
    const rows = processes();
    report.samples.push({ name, processCount: rows.length, workingSet: rows.reduce((n, p) => n + p.workingSet, 0), privateBytes: rows.reduce((n, p) => n + p.privateBytes, 0), rows });
    console.log(name, JSON.stringify(report.samples.at(-1), (key, value) => key === 'rows' ? undefined : value));
    return rows;
  };
  const choose = async (index) => {
    await shell.page.locator('.module-tab').nth(index).click();
    await shell.page.waitForFunction(() => document.querySelectorAll('.module-tab:not(:disabled)').length === 4);
  };
  assert.ok(sample('notes-baseline').some(p => p.command && p.command.includes('WebViews\\shell')),
    'shell must also use the explicit isolated profile');
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const [module, index, port] of [['gallery', 3, 9332], ['asmr', 2, 9331]]) {
      await choose(index);
      assert.equal(await invoke(shell.page, 'embedded_module_status'), module);
      const child = await connect(port);
      child.page.on('pageerror', error => report.errors.push(String(error)));
      await child.page.waitForSelector(module === 'gallery' ? '.gallery-heading' : '.asmr-module-body');
      assert.equal(await child.page.locator('.titlebar').count(), 0, 'child must not duplicate the titlebar');
      await until(async () => !await child.page.locator('.gallery-loading').count());
      if (cycle === 0) {
        const assertBounds = async () => {
          const expected = await shell.page.locator('.window-shell > .app-body').evaluate(el => {
            const rect = el.getBoundingClientRect(); return { width: rect.width, height: rect.height };
          });
          const actual = await child.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          assert.ok(Math.abs(expected.width - actual.width) <= 1 && Math.abs(expected.height - actual.height) <= 1,
            `DPI/resize mismatch: ${JSON.stringify({ expected, actual })}`);
        };
        await assertBounds();
        await invoke(shell.page, 'toggle_maximize_window');
        await sleep(600);
        await assertBounds();
        await invoke(shell.page, 'toggle_maximize_window');
        await sleep(600);
        await assertBounds();
        if (module === 'gallery') {
          await invoke(child.page, 'import_gallery', { input: { paths: [path.join(workspace, 'src-tauri', 'icons', '128x128.png')] } });
          await child.page.getByRole('button', { name: '刷新', exact: true }).click();
          await child.page.waitForSelector('.gallery-card');
          await until(async () => !await child.page.locator('.gallery-loading').count());
        }
        await child.page.screenshot({ path: path.join(output, `${module}.png`) });
        await invoke(child.page, 'set_embedded_module_guard', { reason: 'verification guard' });
        const rejected = await invoke(shell.page, 'switch_embedded_module', {
          module: null, bounds: { x: 0, y: 38, width: 1093, height: 733 },
        }).then(() => false, error => String(error).includes('verification guard'));
        assert.equal(rejected, true, 'busy or unsaved child must not be destroyed');
        await invoke(child.page, 'set_embedded_module_guard', { reason: null });
      }
      const opened = sample(`${module}-open-${cycle}`);
      const childPids = opened.filter(p => p.command && p.command.includes(`WebViews\\${module}`)).map(p => p.pid);
      assert.ok(childPids.length > 0, 'module must use its own profile process group');
      await choose(0);
      await until(() => !processes().some(p => childPids.includes(p.pid)), 20000);
      sample(`${module}-closed-${cycle}`);
      await child.browser.close().catch(() => {});
    }
  }
  // Synthetic silent audio verifies real ASMR -> main-player handoff without
  // touching the production library or playing sound into the user's room.
  const fixture = path.join(output, 'fixtures', 'RJ999999990');
  fs.mkdirSync(fixture, { recursive: true });
  const pcm = Buffer.alloc(44 + 8000 * 2 * 30);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
  fs.writeFileSync(path.join(fixture, 'silent-test.wav'), pcm);
  await choose(2);
  const audioModule = await connect(9331);
  await invoke(audioModule.page, 'import_asmr_work', { input: {
    sourcePath: fixture, rjId: 'RJ999999990', title: 'WebView lifecycle test (silent)', mode: 'copy', overwrite: true,
  } });
  await audioModule.page.getByRole('button', { name: '刷新', exact: true }).click();
  await audioModule.page.getByText('WebView lifecycle test (silent)', { exact: true }).first().click();
  await audioModule.page.locator('.asmr-file-row.is-audio').waitFor();
  await audioModule.page.getByRole('button', { name: '编辑信息', exact: true }).click();
  await audioModule.page.locator('.asmr-metadata-modal input').first().fill('Unsaved verification edit');
  await sleep(200);
  const editBlocked = await invoke(shell.page, 'switch_embedded_module', {
    module: null, bounds: { x: 0, y: 38, width: 1093, height: 733 },
  }).then(() => false, error => String(error).includes('保存或取消'));
  assert.equal(editBlocked, true, 'real metadata edits must prevent destruction');
  await audioModule.page.getByRole('button', { name: '取消', exact: true }).click();
  await sleep(200);
  await shell.page.evaluate(() => { document.querySelector('audio').muted = true; });
  await audioModule.page.locator('.asmr-file-row.is-audio').first().click();
  await until(async () => await invoke(shell.page, 'embedded_module_status') === null);
  await shell.page.waitForFunction(() => {
    const audio = document.querySelector('audio'); return audio && !audio.paused && audio.currentTime > 0;
  });
  assert.equal(await shell.page.locator('.module-tab.is-active').innerText(), '播放器');
  await choose(0);
  assert.equal(await shell.page.evaluate(() => document.querySelector('audio').paused), false);
  await shell.page.evaluate(() => window.dispatchEvent(new CustomEvent('player:quick-action', { detail: 'close' })));
  await until(async () => await invoke(shell.page, 'bootstrap_player') === null);
  await audioModule.browser.close().catch(() => {});
  console.log('PASS: maximize/restore sizing and silent-audio handoff/background playback');
  await shell.page.screenshot({ path: path.join(output, 'shell.png') });
  assert.deepEqual(report.errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: independent profiles, child rendering, close guards and ${cycles * 2} open/close cycles`);
  if (process.argv.includes('--quit')) {
    await choose(3);
    await invoke(shell.page, 'close_window').catch(() => {});
    await until(() => processes().length === 0, 20000);
    console.log('PASS: quitting with a child leaves no experimental process');
  }
  await shell.browser.close();
})().catch(error => { console.error(error); process.exit(1); });
