/**
 * Render Aura at phone size and report what breaks.
 *
 *   npm run build && npx vite preview --port 4173
 *   npx tsx scripts/mobile-audit.ts            # every view, then the overlays
 *   npx tsx scripts/mobile-audit.ts book       # one view, with the detail of
 *                                              # exactly which elements overflow
 *
 * `e2e/mobile.spec.ts` asserts the properties this found; this script is for
 * FINDING the next one. It reports three things, in the order they matter:
 *
 *  1. Horizontal overflow. Not cosmetic — the header once widened the document
 *     to 592px on a 390px screen, and because the playback bar is positioned
 *     `fixed left-1/2`, it centred on 592 and sat half off the right edge. The
 *     app looked fine in a screenshot of the text and you could not press play.
 *  2. Tap targets under 40px.
 *  3. Screenshots, in shots/ — because several of these bugs were invisible to
 *     every assertion and obvious the moment someone looked.
 */
import { chromium, Page, BrowserContext } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'shots');
const BASE = process.env.AURA_PREVIEW ?? 'http://localhost:4173';
const FIXTURE = path.join(ROOT, 'e2e/fixtures/long-passage.jsonl');
const LIB_FIXTURES = ['lib-hearth.jsonl', 'lib-road.jsonl', 'lib-salt.jsonl']
  .map(f => path.join(ROOT, 'e2e/fixtures', f));

// Same staging trick as playwright.config.ts — Chromium's system libs live in a
// user-owned dir on WSL, and this script does not go through the config.
const stagedLibs = path.join(os.homedir(), '.cache/pw-syslibs/root/usr/lib/x86_64-linux-gnu');
if (existsSync(stagedLibs)) {
  process.env.LD_LIBRARY_PATH = [stagedLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

/**
 * `npx tsx scripts/mobile-audit.ts --size=landscape` also checks the two sizes
 * that are neither a desktop nor a portrait phone:
 *   landscape — 844×390, where vertical room, not width, is what runs out
 *   tablet    — 768×1024, just over the `sm` breakpoint, so it gets the
 *               DESKTOP header and has to actually fit it
 */
const SIZES = {
  phone: { width: 390, height: 844 },      // iPhone 13 logical viewport
  landscape: { width: 844, height: 390 },
  tablet: { width: 768, height: 1024 },
} as const;
const sizeArg = process.argv.find(a => a.startsWith('--size='))?.slice(7) as keyof typeof SIZES | undefined;
const PHONE = SIZES[sizeArg ?? 'phone'] ?? SIZES.phone;
const VIEWS = ['storybook', 'chat', 'book', 'stage', 'vn', 'sandbox', 'overview', 'highlights', 'branches'];

/**
 * @param detail when set, report every overflowing element rather than only
 *   the wide ones — the culprit is often a 34px arrow positioned in a margin
 *   the phone does not have.
 */
const probe = (page: Page, detail = false) => page.evaluate((full) => {
  const vw = document.documentElement.clientWidth;
  const over: Record<string, unknown>[] = [];
  const tiny: string[] = [];
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;

    if ((r.right > vw + 1 || r.left < -1) && (full || r.width > 40)) {
      over.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className?.toString?.() ?? '').slice(0, 90),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        pos: cs.position,
        parent: (el.parentElement?.className?.toString?.() ?? '').slice(0, 60),
      });
    }
    const tappable = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT'
      || (el as HTMLElement).getAttribute?.('role') === 'button';
    // A small control can still be easy to hit: an absolutely-positioned
    // ::before with negative insets extends the element's HIT area without
    // touching its box, which is how the colour swatches and the tour's step
    // dots stay visually small. getBoundingClientRect cannot see that, so ask
    // the pseudo-element directly instead of reporting a fix as a fault.
    const before = getComputedStyle(el, '::before');
    const padded = before.content !== 'none' && before.position === 'absolute'
      && [before.top, before.left, before.right, before.bottom].some(v => v.startsWith('-'));
    // A checkbox or radio inside a label is not the target — the label is, and
    // clicking anywhere on it toggles the control. Only flag it if the label
    // is ALSO too small.
    const label = el.closest('label');
    const wrapped = label && label !== el
      && label.getBoundingClientRect().height >= 40
      && (el as HTMLInputElement).type
      && ['checkbox', 'radio'].includes((el as HTMLInputElement).type);

    if (tappable && !padded && !wrapped && cs.opacity !== '0' && (r.width < 40 || r.height < 40)) {
      // Fall back to the tag and a nearby class rather than "?", so an
      // unlabelled control can actually be found in the source.
      const name = (el as HTMLElement).getAttribute('aria-label')
        || (el as HTMLElement).getAttribute('title')
        || (el as HTMLElement).innerText?.trim().slice(0, 24)
        || `<${el.tagName.toLowerCase()}${(el as HTMLInputElement).type ? ` type=${(el as HTMLInputElement).type}` : ''}` +
           ` class="${(el.className?.toString?.() ?? '').slice(0, 40)}">`;
      tiny.push(`${name.replace(/\n/g, ' ')} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  return {
    vw, scrollW: document.documentElement.scrollWidth,
    vh: document.documentElement.clientHeight,
    scrollH: document.documentElement.scrollHeight,
    over: over.slice(0, full ? 20 : 6), tiny,
  };
}, detail);

const report = (label: string, r: Awaited<ReturnType<typeof probe>>) => {
  const wide = r.scrollW > r.vw + 1;
  console.log(`\n${wide ? '✗' : '·'} ${label}`);
  if (wide) console.log(`  OVERFLOW  ${r.scrollW}px in a ${r.vw}px window`);
  for (const o of r.over) console.log(`    ${JSON.stringify(o)}`);
  if (r.tiny.length) console.log(`  SMALL TARGETS (${r.tiny.length})  ${r.tiny.join(' | ')}`);
  return wide || r.tiny.length > 0;
};

const phoneContext = (browser: Awaited<ReturnType<typeof chromium.launch>>, onboarded: boolean) =>
  browser.newContext({
    viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  }).then(async (ctx) => {
    // addInitScript re-runs on EVERY navigation, so a context seeded for the
    // tour keeps re-opening it. One context per state.
    await ctx.addInitScript((on) => {
      localStorage.setItem('aura-reader-settings', JSON.stringify({
        state: {
          onboarded: on, uiMode: 'all', theme: 'dark', livingBackground: false,
          visibleViews: ['storybook', 'chat', 'book', 'stage', 'vn', 'sandbox', 'overview', 'highlights', 'branches'],
        }, version: 2,
      }));
    }, onboarded);
    return ctx;
  });

const openStory = async (page: Page) => {
  await page.goto(BASE);
  await page.waitForTimeout(700);
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForTimeout(600);
  const confirm = page.getByRole('button', { name: 'Import', exact: true }).last();
  if (await confirm.count()) await confirm.click();
  await page.waitForTimeout(1600);
};

const main = async () => {
  const only = process.argv.slice(2).find(a => !a.startsWith('--'));
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let problems = 0;

  // --- The views.
  let ctx: BrowserContext = await phoneContext(browser, true);
  let page = await ctx.newPage();
  await openStory(page);

  for (const view of only ? [only] : VIEWS) {
    const button = page.locator(`[data-view="${view}"]`);
    if (!(await button.count())) { console.log(`\n· ${view} — not on the bar, skipped`); continue; }
    await button.first().click();
    await page.waitForTimeout(1300);
    if (report(view, await probe(page, !!only))) problems++;
    await page.screenshot({ path: path.join(OUT, `${view}.png`) });
  }

  if (!only) {
    /**
     * Reach a tool whichever header is on screen. The phone layout hides them
     * behind one menu; every wider layout puts them straight in the bar, so the
     * menu button simply is not there to click.
     */
    const openTool = async (p: Page, name: RegExp) => {
      const menu = p.getByTestId('tools-menu');
      if (await menu.count()) await menu.click();
      // The accessible name differs by layout: the phone menu shows a short
      // label, the desktop bar uses the full tooltip. Match either.
      await p.getByRole('button', { name }).last().click();
    };

    // --- The overlays that sit on top of them.
    for (const [label, open] of [
      ['tools menu', async (p: Page) => {
        const menu = p.getByTestId('tools-menu');
        if (await menu.count()) await menu.click();
      }],
      ['view menu', async (p: Page) => p.getByTestId('view-overflow').click()],
      ['settings', (p: Page) => openTool(p, /^Settings$/)],
      ['codex', (p: Page) => openTool(p, /^Codex\b/)],
    ] as const) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await open(page);
      await page.waitForTimeout(900);
      if (report(label, await probe(page))) problems++;
      await page.screenshot({ path: path.join(OUT, `overlay-${label.replace(/\W+/g, '-')}.png`) });
    }

    // --- The tour, in its own context, since it needs onboarded: false.
    await ctx.close();
    ctx = await phoneContext(browser, false);
    page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForTimeout(1400);
    for (let step = 1; step <= 13; step++) {
      if (report(`tour step ${step}`, await probe(page))) problems++;
      await page.screenshot({ path: path.join(OUT, `tour-${String(step).padStart(2, '0')}.png`) });
      const next = page.getByTestId('onboarding-next');
      if (!(await next.count())) break;
      await next.click();
      await page.waitForTimeout(450);
    }
  }

  await browser.close();
  console.log(`\n${problems ? `✗ ${problems} surface(s) with problems` : '✓ nothing overflowing, nothing under 40px'}`);
  console.log(`screenshots in ${path.relative(ROOT, OUT)}/`);
  process.exitCode = problems ? 1 : 0;
};

void main().catch(e => { console.error(e); process.exit(1); });
