/// <reference lib="dom" />
/**
 * Browser walkthrough of the production build: drives the main flows with the keyboard,
 * captures screenshots (docs/screenshots) at 1440px and 390px, and fails on
 * horizontal overflow, console errors or any non-local network request.
 *
 * Usage: npm run build && npm run screenshots
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { Canvas } from '../server/lib/png.ts';

const PORT = 4410;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('docs/screenshots');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-shots-'));
fs.mkdirSync(OUT, { recursive: true });

const problems: string[] = [];
let browser: Browser | null = null;
const external = new Set<string>();

const server = spawn(process.execPath, ['server/index.ts', '--data-dir', dataDir, '--port', String(PORT), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, url: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'content-type': 'application/json', 'x-recall-client': '1' }, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}' });
  return r.json();
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`${name}: horizontal overflow of ${overflow}px`);
  console.log(`  ✓ ${name}${overflow > 1 ? ` (overflow ${overflow}px)` : ''}`);
}

function watch(page: Page, label: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label} console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.add(r.url());
  });
}

async function main() {
  await waitForServer();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  watch(page, 'desktop');

  console.log('Desktop 1440px');
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Welcome to your study workspace' }).waitFor();
  await shot(page, '01-onboarding');

  // Keyboard-only onboarding.
  for (const value of ['M.Sc. Informatics', 'Winter semester 2026/27', 'Computer Vision III', 'Week 03 — Object detection']) {
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }
  await page.getByRole('heading', { name: 'Create card' }).waitFor();

  // Card with equation, code and an uploaded image.
  await page.locator('#card-front').fill('Explain the IoU formula $\\mathrm{IoU}(A,B)=\\frac{|A\\cap B|}{|A\\cup B|}$');
  const img = new Canvas(120, 80, [240, 240, 255]);
  img.fillRect(10, 10, 60, 40, [79, 70, 229], 0.6);
  img.fillRect(40, 30, 60, 40, [16, 150, 100], 0.6);
  const imgPath = path.join(dataDir, 'upload.png');
  fs.writeFileSync(imgPath, img.toPng());
  await page.locator('#card-back').click();
  await page.locator('#card-back').fill('```python\ndef iou(a, b):\n    return inter / union\n```\n\n');
  await page.locator('input[type=file]').nth(1).setInputFiles(imgPath);
  await page.waitForFunction(() => (document.querySelector('#card-back') as HTMLTextAreaElement).value.includes('/media/'));
  await page.locator('.md img').first().waitFor();
  await page.locator('.katex').first().waitFor();
  await shot(page, '02-card-editor');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await page.waitForURL(/\/sections\//);

  // Demo content for richer screens.
  await api('POST', '/api/demo');
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Courses', exact: true }).waitFor();
  await shot(page, '03-dashboard');

  const tree = await api('GET', '/api/tree');
  const demoCourse = tree.flatMap((p: any) => p.semesters).flatMap((s: any) => s.courses).find((c: any) => c.title.includes('demo'));
  await page.goto(`${BASE}/courses/${demoCourse.id}`);
  await page.getByRole('heading', { name: 'Sections' }).waitFor();
  await shot(page, '04-course');
  await page.goto(`${BASE}/sections/${demoCourse.sections[1].id}`);
  await page.getByRole('heading', { name: demoCourse.sections[1].title }).waitFor();
  await shot(page, '05-section');

  await page.goto(`${BASE}/organize`);
  await shot(page, '06-organizer');

  // Session builder → study with the keyboard.
  await page.goto(`${BASE}/study/new?course=${demoCourse.id}`);
  await page.getByText('available').first().waitFor();
  await shot(page, '07-session-builder');
  await page.getByRole('button', { name: /^(Start session|Start with)/ }).click();
  await page.waitForURL(/\/study\/[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Show answer' }).waitFor();
  await shot(page, '08-study-question');
  await page.keyboard.press('Space');
  await page.getByRole('dialog', { name: 'How the four ratings work' }).waitFor();
  await shot(page, '09-rating-intro');
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Rate your recall' }).waitFor();
  await shot(page, '10-study-answer');

  // Rate: Bad, then several Very good; reload mid-session to verify resume.
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  const before = await page.locator('article').innerText();
  await page.reload();
  await page.getByRole('button', { name: 'Show answer' }).waitFor();
  const after = await page.locator('article').innerText();
  if (before.split('\n')[0] !== after.split('\n')[0]) problems.push('Reload changed the current card');

  for (let i = 0; i < 20; i++) {
    if (page.url().endsWith('/results')) break;
    const relax = page.getByRole('button', { name: 'Review remaining cards now' });
    if (await relax.isVisible().catch(() => false)) {
      await page.keyboard.press('r');
      await page.waitForTimeout(300);
      continue;
    }
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await page.keyboard.press(i === 2 ? '2' : '3');
    await page.waitForTimeout(300);
  }
  await page.waitForURL(/\/results$/);
  await page.getByText('First rating per card').waitFor();
  await shot(page, '11-results');

  await page.goto(`${BASE}/stats`);
  await page.getByText('Answer attempts per day, by mode', { exact: true }).waitFor();
  await shot(page, '12-statistics');
  await page.goto(`${BASE}/search?q=IoU`);
  await page.getByText(/card/).first().waitFor();
  await shot(page, '13-search');
  await page.goto(`${BASE}/settings`);
  await shot(page, '14-settings');
  await page.goto(`${BASE}/settings#backups`);
  await page.locator('#backups').scrollIntoViewIfNeeded();
  await shot(page, '15-backups');
  await page.goto(`${BASE}/trash`);
  await shot(page, '16-trash');
  await page.goto(`${BASE}/help#study-modes`);
  await page.getByRole('heading', { name: 'How to use Recall' }).waitFor();
  await page.locator('#study-modes').scrollIntoViewIfNeeded();
  await shot(page, '19-help');

  // Dark mode.
  await api('PATCH', '/api/settings', { theme: 'dark' });
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Courses', exact: true }).waitFor();
  await shot(page, '17-dashboard-dark');
  const s2 = await api('POST', '/api/sessions', {
    mode: 'practice',
    scope: { courseIds: [demoCourse.id] },
    filters: { includeNew: true, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all' },
    ordering: 'default',
    size: 10,
    maxAttempts: 3,
    acceptSmaller: true,
  });
  await page.goto(`${BASE}/study/${s2.id}`);
  await page.getByRole('button', { name: 'Show answer' }).waitFor();
  await page.keyboard.press('Space');
  await page.getByRole('group', { name: 'Rate your recall' }).waitFor();
  await shot(page, '18-study-dark');
  await api('PATCH', '/api/settings', { theme: 'light' });

  // Mobile 390px.
  console.log('Mobile 390px');
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  m.setDefaultTimeout(15000);
  const mp = await m.newPage();
  watch(mp, 'mobile');
  await mp.goto(BASE);
  await mp.getByRole('heading', { name: 'Courses', exact: true }).waitFor();
  await shot(mp, '20-mobile-dashboard');
  await mp.getByRole('button', { name: 'Open navigation' }).click();
  await shot(mp, '21-mobile-nav');
  await mp.keyboard.press('Escape');
  await mp.goto(`${BASE}/courses/${demoCourse.id}`);
  await shot(mp, '22-mobile-course');
  await mp.goto(`${BASE}/sections/${demoCourse.sections[1].id}`);
  await shot(mp, '23-mobile-section');
  await mp.goto(`${BASE}/study/${s2.id}`);
  await mp.getByRole('group', { name: 'Rate your recall' }).waitFor();
  await shot(mp, '24-mobile-study');
  await mp.goto(`${BASE}/study/new?course=${demoCourse.id}`);
  await shot(mp, '25-mobile-builder');
  await mp.goto(`${BASE}/cards/new?section=${demoCourse.sections[0].id}`);
  await shot(mp, '26-mobile-editor');
  await mp.goto(`${BASE}/stats`);
  await shot(mp, '27-mobile-stats');
  await mp.goto(`${BASE}/help`);
  await mp.getByRole('heading', { name: 'How to use Recall' }).waitFor();
  await shot(mp, '28-mobile-help');

  await browser.close();
  console.log(`\nScreenshots: ${OUT}`);
  if (external.size) problems.push(`Third-party requests: ${[...external].join(', ')}`);
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else console.log('No overflow, console errors or third-party requests detected.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
