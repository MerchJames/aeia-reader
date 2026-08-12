/**
 * Sandbox mode — the heuristic floor. Pure, AI-free presentation: a
 * deterministic, contrast-safe speaker→color map plus a self-contained iframe
 * document that slots the VERBATIM source text into a themed card.
 *
 * This is the bottom rung of the fallback ladder in SANDBOX_PLAN.md: it renders
 * every message with no AI configured, and every AI treatment layer (later)
 * sits on top of the same slot-injection contract. The model never emits story
 * text — Aura injects the escaped words into `{{body}}` — so source stays sacred.
 */

export interface ThemeVars {
  bg: string;
  surface: string;
  text: string;
  border: string;
  accent: string;
}

interface RGB { r: number; g: number; b: number }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Parse #rgb / #rrggbb / rgb(...) into RGB; null if unrecognised. */
export const parseColor = (raw: string | undefined): RGB | null => {
  if (!raw) return null;
  const s = raw.trim();
  const hex = s.startsWith('#') ? s.slice(1) : s.match(/^rgba?\(([^)]+)\)/i) ? null : s;
  if (hex != null && /^[0-9a-f]{3}$/i.test(hex)) {
    return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
  }
  if (hex != null && /^[0-9a-f]{6}$/i.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return null;
};

const toHex = ({ r, g, b }: RGB): string =>
  '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

const srgb = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const relLum = ({ r, g, b }: RGB) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);

/** WCAG contrast ratio (1..21) between two colors. */
export const contrastRatio = (a: RGB, b: RGB): number => {
  const l1 = relLum(a), l2 = relLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
};

const hslToRgb = (h: number, s: number, l: number): RGB => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: 255 * f(0), g: 255 * f(8), b: 255 * f(4) };
};

/** Stable hue [0,360) from a name — colors persist across sessions, AI-off. */
export const hashHue = (name: string): number => {
  let h = 2166136261;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
};

/**
 * A readable color for a hue against the given surface: scan lightness and take
 * the first candidate clearing 4.5:1 (WCAG AA), else the highest-contrast one.
 * Bright candidates first on dark surfaces, dark-first on light ones.
 */
export const colorForHue = (hue: number, surface: string): string => {
  const surf = parseColor(surface) ?? { r: 30, g: 41, b: 59 };
  const dark = relLum(surf) < 0.5;
  const order = dark ? [0.72, 0.66, 0.78, 0.6, 0.84, 0.55] : [0.4, 0.34, 0.46, 0.28, 0.52, 0.22];
  let best = hslToRgb(hue, 0.62, order[0]); let bestC = 0;
  for (const l of order) {
    const rgb = hslToRgb(hue, 0.62, l);
    const c = contrastRatio(rgb, surf);
    if (c >= 4.5) return toHex(rgb);
    if (c > bestC) { bestC = c; best = rgb; }
  }
  return toHex(best);
};

/** Split composite labels ("Alice & Bob", "Alice/Bob", "Alice and Bob"). */
export const splitSpeakers = (name: string): string[] =>
  name.split(/\s*(?:&|\/|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);

const key = (name: string) => name.trim().toLowerCase();

/** Deterministic, contrast-safe color for one speaker (first of a composite). */
export const speakerColor = (name: string, surface: string): string =>
  colorForHue(hashHue(splitSpeakers(name)[0] ?? name), surface);

/**
 * Assign colors across a cast, nudging hues apart so no two speakers read as the
 * same color (the reference extension's "perceptual conflict repair", minimal).
 */
export const buildSpeakerMap = (names: string[], surface: string): Record<string, string> => {
  const uniq: string[] = [];
  for (const raw of names) for (const n of splitSpeakers(raw)) {
    if (n && !uniq.some(u => key(u) === key(n))) uniq.push(n);
  }
  const placed: number[] = [];
  const map: Record<string, string> = {};
  for (const n of uniq) {
    let hue = hashHue(n);
    // Push at least 24° from every hue already placed (a few tries, then accept).
    for (let i = 0; i < 12; i++) {
      const clash = placed.find(p => { const d = Math.abs(p - hue) % 360; return Math.min(d, 360 - d) < 24; });
      if (clash === undefined) break;
      hue = (hue + 41) % 360;
    }
    placed.push(hue);
    map[key(n)] = colorForHue(hue, surface);
  }
  return map;
};

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Escaped-first body render: blank lines → paragraphs, single newlines → <br>,
 * "quoted speech" wrapped in a colorable span. Escaping happens BEFORE any
 * wrapping so the source text can never break out into markup.
 */
export const formatBody = (content: string): string =>
  escapeHtml(content)
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>').replace(/&quot;([^"]*?)&quot;/g, '<span class="say">&quot;$1&quot;</span>')}</p>`)
    .join('');

/**
 * Our sole, trusted script. Reports content height (so the iframe self-sizes)
 * AND accepts `{t:'aura-sandbox-set', html}` from the parent to live-swap the
 * body — that's how a streaming message updates WITHOUT reloading the whole
 * document (which would replay the entrance animation on every token). The
 * html is authored by Aura (escaped, formatted) — the model never reaches here.
 */
const RUNTIME =
  '<script>(function(){var b=document.getElementById("aura-body");' +
  'function r(){parent.postMessage({t:"aura-sandbox-h",h:document.documentElement.scrollHeight},"*");}' +
  // Keep the reveal edge — the newest streamed text — in view. The reader\'s eye
  // is on the freshest character, so scroll the stage (and any scrollable body
  // wrapper) to its tail after every live swap.
  'function tail(){try{if(b){var e=b.lastElementChild||b;if(e&&e.scrollIntoView)e.scrollIntoView({block:"end",inline:"nearest"});}' +
  'var c=document.querySelector(".card");if(c&&c.scrollHeight>c.clientHeight)c.scrollTop=c.scrollHeight;' +
  'var s=document.scrollingElement||document.documentElement;if(s)s.scrollTop=s.scrollHeight;}catch(_){}}' +
  'function fx(name,ms){var c=document.querySelector(".card")||document.body;var cl="aura-fx-"+name;' +
  'c.classList.remove(cl);void c.offsetWidth;c.classList.add(cl);' +
  'setTimeout(function(){c.classList.remove(cl);},ms||700);}' +
  // Streaming used to do `b.innerHTML = html` on EVERY character. That rebuilds
  // every node under the body, so any CSS animation the scene put on the text
  // restarted 100+ times a second — a one-shot pulse became a permanent throb,
  // and a fade-in became a strobe. The words looked possessed. So reconcile
  // instead: walk the new markup against the live DOM and touch only what
  // actually changed, which while streaming is the last text node's data. Old
  // nodes survive, so their animations keep running instead of restarting.
  'function sync(t,html){var tmp=document.createElement("div");tmp.innerHTML=html;rec(t,tmp);}' +
  'function rec(a,b){var an=a.childNodes,bn=b.childNodes,i;' +
  'for(i=0;i<bn.length;i++){var x=an[i],y=bn[i];' +
  'if(!x){a.appendChild(y.cloneNode(true));continue;}' +
  'if(x.nodeType!==y.nodeType||(x.nodeType===1&&x.nodeName!==y.nodeName)){a.replaceChild(y.cloneNode(true),x);continue;}' +
  'if(x.nodeType===3){if(x.data!==y.data)x.data=y.data;continue;}' +
  'if(x.nodeType===1){var ca=x.getAttribute("class"),cb=y.getAttribute("class");' +
  'if(ca!==cb){if(cb===null)x.removeAttribute("class");else x.setAttribute("class",cb);}rec(x,y);}}' +
  'while(an.length>bn.length)a.removeChild(a.lastChild);}' +
  'addEventListener("message",function(e){var d=e.data;if(!d)return;' +
  'if(d.t==="aura-sandbox-set"){b=b||document.getElementById("aura-body");if(b){sync(b,d.html);r();tail();}}' +
  'else if(d.t==="aura-sandbox-fx"){fx(d.fx,d.ms);}});' +
  'document.addEventListener("click",function(e){var el=e.target.closest&&e.target.closest("[data-act]");if(!el)return;var a=el.getAttribute("data-act");' +
  'if(a==="toggle-text"){document.body.classList.toggle("aura-text-off");r();}' +
  'else parent.postMessage({t:"aura-intent",action:a},"*");});' +
  'try{new ResizeObserver(r).observe(document.body);}catch(e){}addEventListener("load",r);r();})();<\/script>';

/** The cue effect library — transient, CSS-only, motion-gated. Fired by the
 *  runtime's `fx()` on an `aura-sandbox-fx` message; the class self-removes. */
const FX_CSS = `
  [class*="aura-fx-"]{will-change:transform,filter}
  .aura-fx-shake{animation:auraShake .6s cubic-bezier(.36,.07,.19,.97) both}
  .aura-fx-rumble{animation:auraRumble 1s linear both}
  .aura-fx-zoom{animation:auraZoom .8s ease-out both}
  .aura-fx-pulse{animation:auraPulse .7s ease-in-out both}
  .aura-fx-flash{animation:auraFlash .55s ease-out both}
  .aura-fx-glitch{animation:auraGlitch .5s steps(2,end) both}
  .aura-fx-fade{animation:auraFade .9s ease-in-out both}
  @keyframes auraShake{10%,90%{transform:translateX(-4px)}20%,80%{transform:translateX(8px)}30%,50%,70%{transform:translateX(-16px)}40%,60%{transform:translateX(16px)}}
  @keyframes auraRumble{0%,100%{transform:translate(0,0)}10%{transform:translate(-6px,4px) rotate(-.4deg)}20%{transform:translate(6px,-4px) rotate(.4deg)}30%{transform:translate(-8px,-2px)}40%{transform:translate(8px,4px) rotate(.3deg)}50%{transform:translate(-6px,2px)}60%{transform:translate(6px,-4px) rotate(-.3deg)}70%{transform:translate(-4px,4px)}80%{transform:translate(4px,-2px)}90%{transform:translate(-2px,2px)}}
  @keyframes auraZoom{from{transform:scale(1)}45%{transform:scale(1.22)}to{transform:scale(1)}}
  @keyframes auraPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08);filter:brightness(1.3)}}
  @keyframes auraFlash{0%{filter:brightness(3) saturate(1.6)}30%{filter:brightness(1.4)}to{filter:none}}
  @keyframes auraGlitch{0%{transform:translate(0);clip-path:inset(0)}20%{transform:translate(-6px,2px);filter:hue-rotate(60deg)}40%{transform:translate(6px,-2px);clip-path:inset(12% 0 20% 0)}60%{transform:translate(-4px,1px);filter:hue-rotate(-45deg);clip-path:inset(40% 0 30% 0)}80%{transform:translate(4px,0)}100%{transform:translate(0);filter:none}}
  @keyframes auraFade{0%,100%{opacity:1}50%{opacity:.08}}`;

export interface DocOptions {
  name: string;
  isUser: boolean;
  content: string;
  color: string;
  vars: ThemeVars;
  index: number;
  reduceMotion?: boolean;
  images?: string[];
  /** AI treatment (step 2). Its CSS owns the look; an optional skeleton slots
   *  the verbatim text. Absent → the deterministic heuristic card. */
  treatment?: { css: string; skeleton?: string };
  /** Start with the words hidden (the light-switch intent, applied globally). */
  textHidden?: boolean;
  /** Force the reader's text colour (--text) to win over the AI's body colour. */
  forceText?: boolean;
  /** Full-viewport "view" framing (one message fills the screen), not a card. */
  fullFrame?: boolean;
}

/** Fill an AI skeleton's placeholders with escaped verbatim text — never words. */
const fillSkeleton = (skeleton: string, o: DocOptions, bodyBlock: string): string =>
  skeleton
    .replace(/\{\{\s*speaker\s*\}\}/g, escapeHtml(o.name))
    .replace(/\{\{\s*(?:body|body_html)\s*\}\}/g, bodyBlock)
    .replace(/\{\{\s*index\s*\}\}/g, String(o.index))
    .replace(/\{\{\s*is_user\s*\}\}/g, o.isUser ? 'user' : 'char');

/**
 * Build the full sandboxed-iframe document for one message. Strict CSP (no
 * network of any kind), theme exposed as CSS vars so the card sits in the page,
 * the verbatim text slotted into `#aura-body`. With no treatment it's the
 * deterministic heuristic card; with one, the AI's CSS owns the look.
 */
export const buildDoc = (o: DocOptions): string => {
  const body = formatBody(o.content);
  const bodyBlock = `<div class="body" id="aura-body">${body}</div>`;
  const imgs = (o.images ?? [])
    .map(src => `<img src="${escapeHtml(src)}" alt="">`).join('');

  // Theme + this speaker's color as variables the AI (or the heuristic) can use.
  const rootVars = `:root{--who:${o.color};--surface:${o.vars.surface};--bg:${o.vars.bg};`
    + `--text:${o.vars.text};--accent:${o.vars.accent};--border:${o.vars.border}}`;
  const base = `${rootVars}
  *{box-sizing:border-box;max-width:100%} html,body{margin:0}
  body{padding:14px;background:transparent;color:var(--text);font:16px/1.7 ui-serif,Georgia,'Crimson Text',serif}
  img{max-width:100%;height:auto;display:block;border-radius:8px}
  [data-act]{cursor:pointer;user-select:none} .aura-text-off .body{visibility:hidden}
  ${FX_CSS}
  ${o.reduceMotion ? '[class*="aura-fx-"]{animation:none!important}' : ''}
  @media (prefers-reduced-motion:reduce){[class*="aura-fx-"]{animation:none!important}}
  ${o.fullFrame ? 'html,body{height:100%} body{padding:0} .card{min-height:100vh;margin:0!important;border-radius:0;display:flex;flex-direction:column;justify-content:center}' : ''}`;

  let style: string;
  let markup: string;
  if (o.treatment) {
    // The AI owns the look; we only supply the reset + vars beneath it.
    style = `${base}\n${o.treatment.css}`;
    const inner = o.treatment.skeleton
      ? fillSkeleton(o.treatment.skeleton, o, bodyBlock)
      : `<span class="who">${escapeHtml(o.name)}</span>${bodyBlock}${imgs}`;
    markup = `<div class="card">${inner}</div>`;
  } else {
    const motion = o.reduceMotion ? 'none' : 'sandboxIn .5s ease both';
    style = `${base}
  .card{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--who);
    border-radius:12px;padding:16px 18px;box-shadow:0 8px 24px rgba(0,0,0,.28);animation:${motion};
    ${o.isUser ? 'margin-left:12%;' : 'margin-right:12%;'}}
  .who{font:600 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--who);margin-bottom:8px;display:block}
  .body p{margin:0 0 12px} .body p:last-child{margin-bottom:0}
  .say{color:var(--who);font-style:normal} img{margin:12px 0 0}
  @keyframes sandboxIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.card{animation:none}}`;
    markup = `<div class="card"><span class="who">${escapeHtml(o.name)}</span>${bodyBlock}${imgs}</div>`;
  }
  if (o.forceText) style += '\nbody{color:var(--text)!important}';
  // Containment: a view is a FIXED viewport. Lock the page so an AI scene's big
  // type or decoration can never leak outside the screen — clip the page, cap the
  // stage to one screen (scroll inside if it must), and hard-wrap the words.
  if (o.fullFrame) style += "\nhtml,body{overflow:hidden!important;max-width:100vw!important;max-height:100vh!important}"
    + "\n.card{max-height:100vh!important;max-width:100vw!important;overflow:auto!important}"
    // No real descendant may outgrow the stage — kills the horizontal/vertical
    // leak an over-eager AI scene can produce (giant type, off-frame elements).
    //
    // NOT `!important` on max-width: that forces every descendant to exactly
    // 100% and silently discards any NARROWER value, so a scene could never
    // hold a readable column — a paragraph ran the full 1280px of the frame no
    // matter what the stylesheet asked for. Containment is already guaranteed
    // above by the page clamp plus `.card{max-width:100vw;overflow:auto}`; this
    // line only needs to supply the default, not to win every cascade.
    + "\n.card *{max-width:100%;max-height:100vh}"
    + "\n#aura-body,.body{overflow-wrap:break-word;word-break:break-word;max-width:100%}";

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>${style}</style></head>
<body class="${o.textHidden ? 'aura-text-off' : ''}">${markup}${RUNTIME}</body></html>`;
};
