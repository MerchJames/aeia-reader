/**
 * Record the tour's demos as short clips, for a post or a README.
 *
 * The tour steps are already curated, self-contained and animated, which makes
 * them the cheapest honest demo of the app there is — no staging, no editing,
 * and if a demo breaks the clip shows it breaking.
 *
 *   npx tsx scripts/record-tour.ts            # every demo step
 *   npx tsx scripts/record-tour.ts autofocus  # just one, by step id
 *
 * Output lands in `media/`: a .webm per step, plus .gif and .mp4 built with the
 * ffmpeg Playwright already ships, so there is nothing to install.
 *
 * A note on formats, because it decides which file you actually upload:
 * Reddit re-encodes GIFs to video anyway, so an .mp4 uploads smaller, plays
 * smoother and loops fine. Use the GIFs for GitHub READMEs (which do not play
 * mp4 inline) and the mp4s for the post itself.
 */

import { chromium, Page } from '@playwright/test';
import os from 'node:os';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'media');
const RAW = path.join(OUT, '.raw');
const BASE = process.env.AURA_PREVIEW ?? 'http://localhost:4173';

// Same trick playwright.config.ts uses: Chromium's system libs are staged into
// a user-owned dir by scripts/stage-browser-libs.sh (no root needed on WSL).
// This script does not go through the config, so it has to do it itself.
const stagedLibs = path.join(os.homedir(), '.cache/pw-syslibs/root/usr/lib/x86_64-linux-gnu');
if (existsSync(stagedLibs)) {
  process.env.LD_LIBRARY_PATH = [stagedLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

/**
 * An ffmpeg that can actually encode.
 *
 * Playwright ships one, but it is a recording-only build — no GIF encoder, no
 * libx264, not even the `fps` filter. `scripts/stage-ffmpeg.sh` stages a real
 * one into ~/.cache/aura-ffmpeg without root, the same way the repo already
 * stages Chromium's system libraries. Falls back to Playwright's (webm only).
 */
const ffmpegSetup = (() => {
  const staged = path.join(process.env.HOME ?? '', '.cache/aura-ffmpeg/root');
  const bin = path.join(staged, 'usr/bin/ffmpeg');
  if (existsSync(bin)) {
    const lib = path.join(staged, 'usr/lib/x86_64-linux-gnu');
    return {
      bin,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [lib, `${lib}/pulseaudio`, `${lib}/blas`, `${lib}/lapack`].join(':'),
      },
      full: true,
    };
  }
  const base = path.join(process.env.HOME ?? '', '.cache/ms-playwright');
  const dir = existsSync(base) ? readdirSync(base).find(d => d.startsWith('ffmpeg-')) : undefined;
  const pw = dir && path.join(base, dir, 'ffmpeg-linux');
  return pw && existsSync(pw) ? { bin: pw, env: process.env, full: false } : null;
})();

/** Which steps are worth a clip, and how long each needs to make its point. */
const CLIPS: { id: string; title: string; ms: number; act?: (page: Page) => Promise<void> }[] = [
  { id: 'welcome', title: 'Words arrive at reading speed', ms: 6000 },
  {
    id: 'customize', title: 'Pick a look — it applies straight away', ms: 9000,
    act: async (page) => {
      for (const t of ['sepia', 'terminal', 'synthwave', 'book', 'dark']) {
        await page.getByTestId(`tour-theme-${t}`).click();
        await page.waitForTimeout(1100);
      }
    },
  },
  { id: 'kinetic', title: 'The Director bends the reveal', ms: 8000 },
  { id: 'autofocus', title: 'Autofocus follows the words', ms: 8000 },
  {
    id: 'views', title: 'Nine ways to read the same log', ms: 14000,
    act: async (page) => {
      for (const v of ['storybook', 'chat', 'book', 'stage', 'vn', 'sandbox', 'overview', 'highlights', 'branches']) {
        await page.getByTestId(`tour-view-${v}`).hover();
        await page.waitForTimeout(1150);
      }
    },
  },
  {
    id: 'sound', title: 'Ambience, one-shots and read-aloud', ms: 9000,
    act: async (page) => {
      for (const k of ['ambience', 'sfx', 'music']) {
        await page.getByTestId(`tour-audio-${k}`).click();
        await page.waitForTimeout(1400);
      }
    },
  },
  {
    id: 'sandbox', title: 'Or let it design the page', ms: 11000,
    act: async (page) => {
      for (const l of ['giallo', 'terminal', 'storybook', 'neon', 'noir']) {
        await page.getByRole('button', { name: l, exact: true }).click();
        await page.waitForTimeout(1500);
      }
    },
  },
  { id: 'branches', title: 'Every road not taken', ms: 5000 },
  { id: 'markup', title: 'Highlights, notes and pins', ms: 5000 },
];

const only = process.argv[2];
const wanted = only ? CLIPS.filter(c => c.id === only) : CLIPS;
if (!wanted.length) {
  console.error(`no such step: ${only}\nknown: ${CLIPS.map(c => c.id).join(', ')}`);
  process.exit(1);
}

/** Walk the tour to a step by its heading, then let it play. */
const goToStep = async (page: Page, id: string) => {
  const step = (await import('../src/utils/onboarding')).ONBOARDING_STEPS.find(s => s.id === id);
  if (!step) throw new Error(`unknown step ${id}`);
  const tour = page.getByTestId('onboarding');
  for (let i = 0; i < 30; i++) {
    if ((await tour.textContent())?.includes(step.title)) return;
    await page.getByTestId('onboarding-next').click();
  }
  throw new Error(`could not reach step ${id}`);
};

const encode = (webm: string, stem: string) => {
  if (!ffmpegSetup?.full) {
    console.log(`    → ${path.relative(ROOT, webm)} (webm only — run scripts/stage-ffmpeg.sh for gif/mp4)`);
    return;
  }
  const { bin: ffmpeg, env } = ffmpegSetup;
  const mp4 = path.join(OUT, `${stem}.mp4`);
  const gif = path.join(OUT, `${stem}.gif`);
  const palette = path.join(RAW, `${stem}-palette.png`);
  // Crop to the modal: the tour sits centred on a mostly-empty page, and a clip
  // of a dialog surrounded by dead space reads as a screenshot of a screenshot.
  // Generous: the modal is max-w-lg centred, but its height changes per step,
  // and a crop tuned to the shortest one guillotines the title on the tallest.
  const crop = 'crop=iw*0.44:ih*0.94:iw*0.28:ih*0.03';
  try {
    execFileSync(ffmpeg, ['-y', '-i', webm, '-vf', `${crop},fps=24`,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'ignore', env });
    // Two-pass palette: a 256-colour GIF of a dark UI is banded mush otherwise.
    execFileSync(ffmpeg, ['-y', '-i', webm, '-vf', `${crop},fps=14,scale=760:-1:flags=lanczos,palettegen=stats_mode=diff`, palette], { stdio: 'ignore', env });
    execFileSync(ffmpeg, ['-y', '-i', webm, '-i', palette, '-lavfi',
      `${crop},fps=14,scale=760:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, gif], { stdio: 'ignore', env });
    console.log(`    → ${path.relative(ROOT, mp4)}  +  ${path.relative(ROOT, gif)}`);
  } catch {
    console.log(`    → ${path.relative(ROOT, webm)} (encode failed; the webm is still good)`);
  }
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(RAW, { recursive: true });
  console.log(`Recording ${wanted.length} clip(s) from ${BASE}`);
  if (!ffmpegSetup?.full) console.log('(no full ffmpeg — writing .webm only; see scripts/stage-ffmpeg.sh)');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const clip of wanted) {
    process.stdout.write(`  ${clip.id.padEnd(11)} ${clip.title}\n`);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    // A fresh reader, so the tour is the first thing on screen.
    await page.addInitScript(() => {
      localStorage.setItem('aura-reader-settings',
        JSON.stringify({ state: { onboarded: false, theme: 'dark' }, version: 2 }));
    });
    await page.goto(BASE);
    await page.getByTestId('onboarding').waitFor({ timeout: 20_000 });
    await goToStep(page, clip.id);
    await page.waitForTimeout(700);          // let the step settle before rolling
    if (clip.act) await clip.act(page);
    else await page.waitForTimeout(clip.ms);
    await page.waitForTimeout(400);
    await context.close();                    // flushes the video

    const raw = readdirSync(RAW).filter(f => f.endsWith('.webm'));
    const newest = raw.map(f => path.join(RAW, f))
      .sort((a, b) => Number(existsSync(b)) - Number(existsSync(a)))[raw.length - 1];
    if (!newest) { console.log('    (no video written)'); continue; }
    const webm = path.join(OUT, `${clip.id}.webm`);
    renameSync(newest, webm);
    encode(webm, clip.id);
  }
  await browser.close();
  rmSync(RAW, { recursive: true, force: true });
  console.log(`\nDone — files in ${path.relative(ROOT, OUT)}/`);
  console.log('Upload the .mp4 to Reddit (it re-encodes GIFs anyway); use the .gif in the README.');
};

void main().catch(e => { console.error(e); process.exit(1); });
