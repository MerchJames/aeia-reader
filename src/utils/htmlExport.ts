/**
 * A story as one self-contained HTML file.
 *
 * The point is to hand someone a chat and have it look — and read — the way you
 * read it. That means the theme's colours, YOUR font (embedded, not merely
 * named), your type size and column width, the dialogue styling, your
 * highlights, the Director's per-scene mood, both reading layouts, and the
 * streaming reveal itself.
 *
 * What it deliberately does NOT reproduce: the theme decorations that live only
 * in `src/index.css` (CRT scanlines, Win98 chrome, Synthwave grid). Those are
 * ~2,900 lines written against the app's DOM; extracting them would tie the
 * exporter to every future change in it.
 *
 * Self-containment is a hard rule: nothing is fetched when the file is opened.
 * Fonts are inlined as data URIs, avatars are already data URLs, and the one
 * script is Aura's own — a remote image is dropped with a note rather than left
 * as a link that rots or reports who opened it.
 */

import type { Mood, SceneDescriptor, SceneEmphasis, ScenePerformCue, Story } from '../types';
import type { ThemeDef } from '../themes';
import { AEIA_MARK } from '../assets/aeiaMark';
import { renderInline } from './bookLayout';
import { MOOD_COLOR, sceneAtmosphere } from './sceneMood';
import { WalkedStory, minutesFor } from './storyWalk';
import {
  EMPHASIS_CSS, PERFORM_CSS, emphasisWordKinds, markSceneHtml, readerEmphasis,
} from './performMarkup';
import { mergePerformCues, performMatcher, performWordKinds } from './scenePerform';

/** Which reading layout the exported page opens in. */
export type ExportLayout = 'storybook' | 'chat';

export interface ExportTypography {
  /** Resolved CSS font stack — see `FONT_STACKS` in `fontEmbed`. */
  stack: string;
  /** Base type size in px, as the reader set it. */
  fontSize: number;
  /** Column width in px; 0 means "use the export's comfortable default". */
  contentWidth: number;
  /** Extra air between paragraphs, matching the reader's setting. */
  paragraphSpacing: boolean;
  /** `@font-face` rules with the bytes inlined. */
  faceCss?: string;
}

export interface ExportOptions {
  theme: ThemeDef;
  accent?: string;
  typography: ExportTypography;
  layout?: ExportLayout;
  scenes?: Record<string, SceneDescriptor>;
  highlights?: Story['highlights'];
  sceneMood?: boolean;
  /** Include the reveal script and its play button. */
  streaming?: boolean;
  /**
   * Carry the Director's emphasis and performance treatments into the file.
   *
   * The export reproduced the theme, the font and the scene mood and then threw
   * away the two tracks that make a directed passage LOOK directed — a shouted
   * line arrived flat, a swelled word plain. On by default when scenes are
   * present; a static file plays each mark once on open, which is the same
   * budget the reader gets on a finished message.
   */
  sceneMarks?: boolean;
  /**
   * The reader's OWN marks, per message id — hand-marked typography, sound
   * anchors and performance directions.
   *
   * Separate from `scenes` because they have separate lives: the Director's read
   * is rebuilt whenever a passage changes, and a mark the reader made by hand
   * outlives it. The export carried the Director's read and dropped the
   * reader's, which meant the one part of the page that was unmistakably theirs
   * was the part that did not survive being saved.
   */
  readerMarks?: {
    emphasis?: Record<string, SceneEmphasis[]>;
    sfx?: Record<string, { text: string }[]>;
    perform?: Record<string, ScenePerformCue[]>;
  };
  /** Open on a title page. On by default; `false` starts at chapter one. */
  cover?: boolean;
  /** Stamped on the cover. Injected rather than read from the clock so the
   *  output is reproducible and the tests can pin a date. */
  exportedAt?: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Only `data:` survives — anything else would make the file phone home. */
export const isSelfContained = (src: string): boolean => src.startsWith('data:');

const moodTint = (mood: Mood, tension: number): string => {
  const a = sceneAtmosphere(mood, tension);
  if (!a.washOpacity) return '';
  return `--tint:${MOOD_COLOR[mood]};--tint-a:${a.washOpacity.toFixed(3)}`;
};

/** A stable colour for a speaker with no portrait, mirroring the reader's. */
const avatarColor = (name: string): string => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 45% 45%)`;
};

/**
 * The stylesheet: the theme's variables, the reader's typography, and both
 * layouts. Written for this document rather than lifted out of the app's CSS.
 */
export const readingStylesheet = (
  theme: ThemeDef,
  type: ExportTypography,
  accent?: string,
): string => {
  const v = theme.vars;
  const width = type.contentWidth > 0 ? `${type.contentWidth}px` : '38rem';
  const para = type.paragraphSpacing ? '1.35em' : '1em';
  return `
${type.faceCss ?? ''}
:root{
--bg:${v.bg};--surface:${v.surface};--text:${v.text};--muted:${v.muted};
--accent:${accent || v.accent};--border:${v.border};
--bubble-ai:${v.bubbleAi};--bubble-user:${v.bubbleUser};--bubble-user-text:${v.bubbleUserText};
--w:${width};--fs:${type.fontSize}px;--para:${para};
--tint:transparent;--tint-a:0}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
font-family:${type.stack};font-size:var(--fs);line-height:1.75;padding:0 0 6rem}
main,header.story,nav.toc{max-width:var(--w);margin-left:auto;margin-right:auto;padding-left:1.25rem;padding-right:1.25rem}
/* The per-chapter mood wash is inset -2rem so it bleeds past the column, which
   on a phone pushed the DOCUMENT 12px wider than the viewport — and a document
   wider than the viewport drags everything positioned against it sideways.
   clip, not hidden: it trims the bleed without making main a scroll
   container. */
main{overflow-x:clip}
header.story{padding-top:3.5rem;padding-bottom:2rem}
h1{font-size:1.9em;line-height:1.15;margin:0 0 .4rem;letter-spacing:-.01em}
.byline{color:var(--muted);font-size:.95em;margin:0}
.meta{color:var(--muted);font-size:.82em;margin:.6rem 0 0}
nav.toc{padding-top:1rem;padding-bottom:1rem;margin-bottom:2.5rem;
border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
nav.toc h2{font-size:.72em;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .6rem;font-weight:600}
nav.toc ol{margin:0;padding-left:1.1rem;columns:2;column-gap:1.5rem}
nav.toc li{margin:.15rem 0;font-size:.9em}
nav.toc a{color:var(--text);text-decoration:none;opacity:.8}
nav.toc a:hover{opacity:1;text-decoration:underline}
section.chapter{position:relative;padding:2rem 0 1rem}
section.chapter::before{content:"";position:absolute;inset:-1rem -2rem;
background:var(--tint);opacity:var(--tint-a);pointer-events:none;z-index:0;
border-radius:1.5rem;filter:blur(28px)}
section.chapter>*{position:relative;z-index:1}
h2.chapter{font-size:.72em;letter-spacing:.16em;text-transform:uppercase;
color:var(--muted);font-weight:600;margin:0 0 1.5rem;
padding-bottom:.5rem;border-bottom:1px solid var(--border)}
article{margin:0 0 1.6rem;display:flex;gap:.75rem;align-items:flex-start}
.who{font-size:.7em;letter-spacing:.13em;text-transform:uppercase;
color:var(--muted);font-weight:700;margin:0 0 .35rem}
article.user .who{color:var(--accent)}
.body{min-width:0;flex:1}
.body p{margin:0 0 var(--para)}
.body p:last-child{margin-bottom:0}
.pic{width:2.5rem;height:2.5rem;border-radius:50%;flex-shrink:0;overflow:hidden;
display:grid;place-items:center;color:#fff;font-weight:700;font-size:.9em;
margin-top:.15rem}
.pic img{width:100%;height:100%;object-fit:cover;margin:0;border-radius:0}
.book-say{color:var(--accent)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;
background:color-mix(in srgb,var(--text) 8%,transparent);padding:.1em .35em;border-radius:.25em}
mark{background:color-mix(in srgb,var(--accent) 32%,transparent);color:inherit;
border-radius:.15em;padding:.05em .1em}
img{max-width:100%;height:auto;border-radius:.5rem;display:block;margin:1rem 0}
.dropped{color:var(--muted);font-size:.8em;font-style:italic}
footer{max-width:var(--w);margin:3rem auto 0;padding:1.5rem 1.25rem;
border-top:1px solid var(--border);color:var(--muted);font-size:.8em}

/* --- The cover -----------------------------------------------------------
   ONE block of markup with two treatments, so the page's own layout toggle
   turns the title page of a book into the head of a conversation and back.
   Nothing here is duplicated per layout except the parts that must differ. */
header.cover{position:relative;display:flex;flex-direction:column;
align-items:center;justify-content:center;text-align:center;
padding:4rem 1.5rem 3rem;gap:0}
.cover-inner{max-width:var(--w);width:100%}
.cover .kicker{margin:0 0 1rem;color:var(--muted);font-size:.7em;
letter-spacing:.2em;text-transform:uppercase;font-weight:600}
.cover h1{font-size:clamp(2.1em,7vw,3.2em);line-height:1.08;margin:0;
letter-spacing:-.02em;text-wrap:balance}
.cover .byline{margin:1rem 0 0;font-size:1.05em;color:var(--text);opacity:.75}
.cover .stat{margin:.35rem 0 0;color:var(--muted);font-size:.85em}
.cover .dateline{margin:.15rem 0 0;color:var(--muted);font-size:.78em;opacity:.75}
.cover .art{width:8.5rem;height:8.5rem;margin:0 auto 2rem;border-radius:50%;
overflow:hidden;display:grid;place-items:center;color:#fff;font-weight:700;
font-size:3rem;box-shadow:0 10px 40px rgba(0,0,0,.28)}
/* A book gets a plate, a chat gets a portrait — the shape does as much of the
   work of saying which one you are looking at as the wording does. */
body[data-layout="storybook"] .cover .art{width:9.5rem;height:12.5rem;
border-radius:.6rem}
.cover .art img{width:100%;height:100%;object-fit:cover;margin:0;border-radius:0}
.cover .rule{width:3.5rem;height:2px;background:var(--accent);opacity:.85;
margin:1.75rem auto 0;border-radius:2px}
.cover .begin{display:inline-block;margin-top:2.5rem;color:var(--muted);
font-size:.78em;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;
padding:.5rem .9rem;border:1px solid var(--border);border-radius:999px}
.cover .begin:hover{color:var(--text);border-color:var(--accent)}
/* The mark, in the corner of the first page and nowhere else. */
.cover .aeia{position:absolute;top:1.25rem;right:1.25rem;display:flex;
align-items:center;gap:.4rem;color:var(--muted);font-size:.62em;
letter-spacing:.1em;text-transform:uppercase;font-weight:600;opacity:.6}
.cover .aeia img{width:auto;height:1.15rem;margin:0;border-radius:0;
display:block;flex-shrink:0}
@media (max-width:480px){.cover .aeia span{display:none}}

/* Storybook: a title page — the whole first screen, portrait as a plate. */
body[data-layout="storybook"] header.cover{min-height:100svh}
body[data-layout="storybook"] .cover h1{font-family:inherit}

/* Chat: the head of a conversation — compact, and it says who you are
   talking to rather than announcing a work. */
body[data-layout="chat"] header.cover{min-height:0;padding-bottom:1rem}
body[data-layout="chat"] .cover h1{font-size:clamp(1.6em,5vw,2.1em)}
body[data-layout="chat"] .cover .art{width:6rem;height:6rem;
margin-bottom:1.25rem;font-size:2.2rem}
body[data-layout="chat"] .cover .rule{display:none}
body[data-layout="chat"] .cover .begin{display:none}
/* "The beginning of this conversation" sits AFTER the contents list, not
   inside the cover: announcing the start of the chat and then showing a table
   of contents reads as though the story had already begun twice. */
p.convo-start{display:none;max-width:var(--w);margin:0 auto 2rem;
padding:0 1.25rem;text-align:center;color:var(--muted);font-size:.72em;
letter-spacing:.1em;text-transform:uppercase}
body[data-layout="chat"] p.convo-start{display:block}
.cover .book-only{display:none}
body[data-layout="storybook"] .cover .book-only{display:block}
.cover .chat-only{display:none}
body[data-layout="chat"] .cover .chat-only{display:block}

/* --- Storybook: continuous prose, no portraits, speakers as small labels. */
body[data-layout="storybook"] .pic{display:none}

/* --- Chat: bubbles, portraits, the reader's turns on the right. */
body[data-layout="chat"] .who{margin-bottom:.25rem}
body[data-layout="chat"] .body{background:var(--bubble-ai);border-radius:1rem;
padding:.75rem 1rem;flex:0 1 auto;max-width:min(100%,34rem)}
body[data-layout="chat"] article.user{flex-direction:row-reverse}
body[data-layout="chat"] article.user .body{background:var(--bubble-user);
color:var(--bubble-user-text);border-left:none;padding-left:1rem}
body[data-layout="chat"] article.user .who{text-align:right;color:inherit;opacity:.7}
body[data-layout="storybook"] article.user .body{border-left:2px solid var(--accent);
padding-left:1rem;opacity:.92}

/* --- The reveal. Words are wrapped by the script, never in the file. */
.aura-w{opacity:0}
.aura-w.on{opacity:1;transition:opacity .18s ease-out}
#aura-bar{position:fixed;left:50%;transform:translateX(-50%);
bottom:calc(1rem + env(safe-area-inset-bottom,0px));z-index:9;
display:flex;align-items:center;gap:.6rem;padding:.5rem .75rem;
border-radius:999px;border:1px solid var(--border);background:var(--surface);
box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:.8rem;font-family:system-ui,sans-serif}
#aura-bar button{font:inherit;color:var(--text);background:none;border:none;
cursor:pointer;min-height:2.5rem;min-width:2.5rem;display:grid;place-items:center;
border-radius:999px;padding:0 .6rem}
#aura-bar button:hover{background:color-mix(in srgb,var(--text) 10%,transparent)}
#aura-bar input{accent-color:var(--accent);width:6rem}
#aura-layout{display:flex;gap:.15rem}
#aura-layout button[aria-pressed="true"]{background:var(--accent);color:#fff}
/* A playback pill at full weight across a title page competes with it. It
   recedes there — but stays lit and stays clickable, because on a storybook
   cover the first screen is ALL cover, and hiding the bar outright is how the
   layout toggle became unreachable until you scrolled. */
#aura-bar{transition:opacity .25s ease}
#aura-bar.on-cover{opacity:.4}
#aura-bar.on-cover:hover,#aura-bar.on-cover:focus-within{opacity:1}

@media print{
body{background:#fff;color:#000;padding:0}
section.chapter::before,nav.toc,#aura-bar,.cover .begin{display:none}
.aura-w{opacity:1}
header.cover{min-height:0;break-after:page;padding-top:6rem}
article{break-inside:avoid}}
@media (max-width:480px){nav.toc ol{columns:1}
body[data-layout="chat"] .body{max-width:100%}}
@media (prefers-reduced-motion:reduce){.aura-w,.aura-w.on{transition:none}}
`.trim();
};

/**
 * The reveal, as a script rather than as markup.
 *
 * Words are wrapped at play time, not at export time: baking a span around
 * every word would roughly triple the file, and it would make the document
 * unreadable to anything that does not run scripts. With this, the page is a
 * finished, printable, selectable document until someone presses play.
 */
const REVEAL_SCRIPT = `
(function(){
var body=document.body,bar=document.getElementById('aura-bar');
if(!bar)return;
var playBtn=document.getElementById('aura-play');
var ICON_PLAY='<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE='<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
var speed=document.getElementById('aura-speed');
var words=null,i=0,timer=null,playing=false;

function wrap(){
  if(words)return;
  words=[];
  var ps=document.querySelectorAll('.body p, .body li');
  for(var p=0;p<ps.length;p++){
    var walk=document.createTreeWalker(ps[p],NodeFilter.SHOW_TEXT),n,nodes=[];
    while((n=walk.nextNode()))nodes.push(n);
    for(var k=0;k<nodes.length;k++){
      var parts=(nodes[k].textContent||'').split(/(\\s+)/),frag=document.createDocumentFragment();
      for(var j=0;j<parts.length;j++){
        if(!parts[j])continue;
        if(/^\\s+$/.test(parts[j])){frag.appendChild(document.createTextNode(parts[j]));continue;}
        var s=document.createElement('span');
        s.className='aura-w';s.textContent=parts[j];
        frag.appendChild(s);words.push(s);
      }
      nodes[k].parentNode.replaceChild(frag,nodes[k]);
    }
  }
}
function show(upto){for(var k=0;k<words.length;k++)words[k].classList.toggle('on',k<upto);}
function step(){
  if(!playing)return;
  if(i>=words.length){stop();return;}
  words[i].classList.add('on');
  if(i%12===0)words[i].scrollIntoView({block:'center',behavior:'smooth'});
  i++;
  timer=setTimeout(step,Math.max(12,600/Number(speed.value||6)));
}
function play(){
  wrap();
  if(i>=words.length){i=0;show(0);}
  playing=true;body.classList.add('aura-playing');
  playBtn.innerHTML=ICON_PAUSE;playBtn.setAttribute('aria-label','Pause');
  // Starting from the top with the page scrolled somewhere else leaves the
  // reader looking at blank space — every word below is invisible until the
  // reveal reaches it. Go to where the words actually are.
  if(i===0&&words.length)words[0].scrollIntoView({block:'center'});
  step();
}
function pause(){playing=false;clearTimeout(timer);
  playBtn.innerHTML=ICON_PLAY;playBtn.setAttribute('aria-label','Play');}
function stop(){pause();body.classList.remove('aura-playing');}
playBtn.addEventListener('click',function(){playing?pause():play();});
document.getElementById('aura-all').addEventListener('click',function(){
  wrap();stop();i=words.length;show(words.length);});
var lay=document.getElementById('aura-layout');
if(lay)lay.addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  body.setAttribute('data-layout',b.dataset.layout);
  var all=lay.querySelectorAll('button');
  for(var k=0;k<all.length;k++)all[k].setAttribute('aria-pressed',String(all[k]===b));
});
document.addEventListener('keydown',function(e){
  if(e.key===' '&&e.target===document.body){e.preventDefault();playing?pause():play();}
});
// Keep the pill off the title page. IntersectionObserver where it exists,
// nothing at all where it doesn't — the bar is simply always visible then.
var cover=document.querySelector('header.cover');
if(cover&&window.IntersectionObserver){
  bar.classList.add('on-cover');
  new IntersectionObserver(function(es){
    bar.classList.toggle('on-cover',es[0].intersectionRatio>0.55);
  },{threshold:[0,0.55,1]}).observe(cover);
}
})();
`.trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Paint the reader's highlights back into a passage.
 *
 * Matched on the highlight's own text rather than an offset: offsets are into
 * the RAW message, and by the time the exporter sees it the text has been
 * through the Lens and `processText`, so any stored offset is meaningless.
 *
 * ONE pass, with the texts as a single alternation. Looping and re-splitting
 * per highlight re-scanned the marks the previous pass had inserted, so every
 * highlight grew the whole document by another layer — output size climbed
 * linearly with the number of highlights and the work quadratically, until a
 * well-marked story exported as hundreds of megabytes and V8 refused with
 * "Invalid string length". Longest first, so "the hearth" wins over "hearth"
 * rather than being cut in half by it.
 */
const applyHighlights = (html: string, texts: string[]): string => {
  const pattern = [...new Set(texts.map(t => t.trim()))]
    .filter(t => t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(t => escapeRe(escapeHtml(t)));
  if (!pattern.length) return html;
  const re = new RegExp(pattern.join('|'), 'g');
  return html.split(/(<[^>]+>)/)
    .map(part => (part.startsWith('<') ? part : part.replace(re, m => `<mark>${m}</mark>`)))
    .join('');
};

/** "about 40 min" / "about 2 hr 40 min" — a length, not a number of minutes. */
export const readingLength = (words: number): string => {
  const mins = minutesFor(words);
  if (mins < 60) return `about ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `about ${h} hr${m ? ` ${m} min` : ''}`;
};

/**
 * The title page.
 *
 * One block of markup, two treatments — CSS decides whether this reads as the
 * cover of a book or as the head of a conversation, so the page's own layout
 * toggle switches the cover along with everything else rather than leaving a
 * book cover sitting on top of a chat log.
 *
 * The Aeia mark goes in the corner HERE and nowhere else in the document: a
 * logo repeated down the side of somebody's story is a watermark, not a
 * credit.
 */
const coverHtml = (walked: WalkedStory, layout: ExportLayout, at: number): string => {
  const who = walked.characterName || walked.messages.find(m => m.role === 'ai')?.name || '';
  const art = walked.coverImage && isSelfContained(walked.coverImage)
    ? `<span class="art"><img src="${escapeHtml(walked.coverImage)}" alt=""></span>`
    : who
      ? `<span class="art" style="background:${avatarColor(who)}">${escapeHtml(who.charAt(0).toUpperCase())}</span>`
      : '';

  const both = [walked.characterName, walked.userName].filter(Boolean);
  const byline = both.length ? both.join(' &amp; ') : '';
  const stat = `${walked.messages.length.toLocaleString()} passage${walked.messages.length === 1 ? '' : 's'}`
    + ` · ${walked.wordCount.toLocaleString()} words · ${readingLength(walked.wordCount)}`;

  // Locale-formatted, because whoever opens the file is the audience for it.
  let date = '';
  try {
    date = new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { date = new Date(at).toISOString().slice(0, 10); }

  // The one line that genuinely differs: a book announces itself, a chat tells
  // you who you were talking to. Both ship; CSS shows one.
  const kicker = `<p class="kicker book-only">A story, kept</p>`
    + `<p class="kicker chat-only">${who ? `Conversation with ${escapeHtml(who)}` : 'Conversation'}</p>`;

  const first = walked.chapters[0];
  return `<header class="cover">
<p class="aeia"><img src="${AEIA_MARK}" alt="">
<span>Aeia Reader</span></p>
<div class="cover-inner">
${art}
${kicker}
<h1>${escapeHtml(walked.title)}</h1>
${byline ? `<p class="byline">${byline}</p>` : ''}
<p class="stat">${stat}</p>
<p class="dateline">Exported ${escapeHtml(date)}</p>
<div class="rule"></div>
${first ? `<a class="begin" href="#ch${first.index}">Begin reading</a>` : ''}
</div>
</header>`;
};

export interface ExportResult {
  html: string;
  /** Remote images that could not be embedded, so the caller can say so. */
  droppedImages: number;
}

export const exportStoryHtml = (
  walked: WalkedStory,
  opts: ExportOptions,
): ExportResult => {
  let dropped = 0;
  // A highlight belongs to ONE message. Applying every highlight to every
  // passage painted the same words all over the story — wrong on its face, and
  // the reason the work grew with (highlights × messages) rather than with the
  // story. `messageId` is optional on older highlights, so those still fall
  // back to matching anywhere.
  const byMessage = new Map<string, string[]>();
  const anywhere: string[] = [];
  for (const h of opts.highlights ?? []) {
    if (!h.text?.trim()) continue;
    if (h.messageId) {
      const list = byMessage.get(h.messageId);
      if (list) list.push(h.text);
      else byMessage.set(h.messageId, [h.text]);
    } else {
      anywhere.push(h.text);
    }
  }
  const layout: ExportLayout = opts.layout ?? 'storybook';
  const marks = opts.sceneMarks !== false && (!!opts.scenes || !!opts.readerMarks);

  const chapterHtml = walked.chapters.map(ch => {
    const d = ch.messages.map(m => opts.scenes?.[m.id]).find(Boolean);
    const tint = opts.sceneMood !== false && d ? moodTint(d.mood, d.tension) : '';
    const label = d?.location || d?.mood;

    const body = ch.messages.map(m => {
      let inner = m.text.split(/\n{2,}/).map(p => `<p>${renderInline(p)}</p>`).join('');
      const mine = byMessage.get(m.id);
      if (mine || anywhere.length) inner = applyHighlights(inner, [...(mine ?? []), ...anywhere]);
      // The Director's two tracks, marked through the same scanner the reader
      // uses — so a passage reads the way it read on screen.
      if (marks) {
        const d = opts.scenes?.[m.id];
        const emph = emphasisWordKinds(readerEmphasis(
          d?.emphasis, opts.readerMarks?.sfx?.[m.id], opts.readerMarks?.emphasis?.[m.id],
        ), true);
        const cues = mergePerformCues(opts.readerMarks?.perform?.[m.id], d?.perform);
        const perf = performWordKinds(cues);
        const match = performMatcher(cues);
        if (emph || perf || match) {
          inner = markSceneHtml(inner, emph, perf, new Set<string>(), false, undefined, match);
        }
      }
      const imgs = m.images.map(src => {
        if (!isSelfContained(src)) { dropped++; return ''; }
        return `<img src="${escapeHtml(src)}" alt="">`;
      }).join('');

      const pic = m.avatar && isSelfContained(m.avatar)
        ? `<span class="pic"><img src="${escapeHtml(m.avatar)}" alt=""></span>`
        : `<span class="pic" style="background:${avatarColor(m.name)}">${escapeHtml(m.name.charAt(0).toUpperCase())}</span>`;

      return `<article class="${m.role === 'user' ? 'user' : 'ai'}">${pic}`
        + `<div class="body"><p class="who">${escapeHtml(m.name)}</p>${inner}${imgs}</div></article>`;
    }).join('\n');

    return `<section class="chapter" id="ch${ch.index}"${tint ? ` style="${tint}"` : ''}>`
      + `<h2 class="chapter">Chapter ${ch.index}${label ? ` · ${escapeHtml(label)}` : ''}</h2>`
      + `${body}</section>`;
  }).join('\n');

  const toc = walked.chapters.length > 1
    ? `<nav class="toc"><h2>Contents</h2><ol>${walked.chapters.map(ch => {
        const d = ch.messages.map(m => opts.scenes?.[m.id]).find(Boolean);
        const label = d?.location || d?.mood || `Chapter ${ch.index}`;
        return `<li><a href="#ch${ch.index}">${escapeHtml(label)}</a></li>`;
      }).join('')}</ol></nav>`
    : '';

  const byline = [walked.characterName, walked.userName].filter(Boolean).join(' &amp; ');
  const showCover = opts.cover !== false;
  const cover = showCover ? coverHtml(walked, layout, opts.exportedAt ?? Date.now()) : '';

  // The control bar carries the reveal AND the layout toggle, so it ships
  // whenever either is on.
  const bar = opts.streaming !== false
    ? `<div id="aura-bar">
<button id="aura-play" aria-label="Play"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg></button>
<label>Speed <input id="aura-speed" type="range" min="2" max="20" value="7" aria-label="Reading speed"></label>
<button id="aura-all">Show all</button>
<span id="aura-layout">
<button data-layout="storybook" aria-pressed="${layout === 'storybook'}">Prose</button>
<button data-layout="chat" aria-pressed="${layout === 'chat'}">Chat</button>
</span>
</div>
<script>${REVEAL_SCRIPT}</script>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(walked.title)}</title>
<style>${readingStylesheet(opts.theme, opts.typography, opts.accent)}${marks ? PERFORM_CSS + EMPHASIS_CSS : ''}</style>
</head>
<body data-layout="${layout}">
${cover || `<header class="story">
<h1>${escapeHtml(walked.title)}</h1>
${byline ? `<p class="byline">${byline}</p>` : ''}
<p class="meta">${walked.messages.length} passages · ${walked.wordCount.toLocaleString()} words · ${readingLength(walked.wordCount)}</p>
</header>`}
${toc}
${showCover ? '<p class="convo-start">The beginning of this conversation</p>' : ''}
<main>
${chapterHtml}
${dropped > 0 ? `<p class="dropped">${dropped} image${dropped === 1 ? '' : 's'} could not be embedded and were left out, so this file stays self-contained.</p>` : ''}
</main>
<footer>Exported from Aeia Reader. This file is self-contained — it loads nothing from the network.</footer>
${bar}
</body>
</html>`;

  return { html, droppedImages: dropped };
};
