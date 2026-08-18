/**
 * Book layout — typesets the story into real pages for the book view.
 *
 * Pagination is done by DOM measurement (an offscreen column styled exactly
 * like a page body), so what fits on a page is decided by the browser's own
 * line breaking — the same way an e-reader does it. Blocks are whole
 * paragraphs; an oversized paragraph is pre-split at sentence boundaries so
 * a page never has to clip text.
 */

export interface BookBlock {
  /** Full outer HTML of the block, ready for both measuring and rendering. */
  html: string;
  /** Chapter title carried as the running head from this block onward. */
  chapter?: string;
  messageId?: string;
}

export interface BookPage {
  /** The blocks on this page, kept separate so a tail re-flow can resume. */
  blocks: BookBlock[];
  /** Running head (current chapter) for this page. */
  chapter?: string;
}

export const pageHtml = (page: BookPage | undefined): string =>
  page ? page.blocks.map(b => b.html).join('') : '';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Minimal inline markdown → HTML for book prose. The book view is a reading
 * surface: paragraphs, emphasis, dialogue and the odd image plate — tables
 * and the rest stay with the chat/storybook views.
 */
export const renderInline = (md: string, opts?: { images?: boolean }): string => {
  let s = escapeHtml(md);
  // Generated HTML is parked behind private-use sentinels until the end —
  // otherwise later passes chew it up (the dialogue pass used to wrap the
  // quotes of <img src="..."> in .book-say spans, destroying every image).
  const guarded: string[] = [];
  const guard = (html: string): string => `\uE000${guarded.push(html) - 1}\uE001`;
  // Code spans first, so their contents are never styled further.
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => guard(`<code>${c}</code>`));
  // Image plates get a fixed-height box so pagination stays deterministic
  // even before the image loads. Honors the reader's "show images" setting.
  s = s.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_m, src) =>
    opts?.images === false
      ? ''
      : guard(`<span class="book-plate"><img src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`));
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  /**
   * Underscore emphasis. Standard markdown, and this renderer never handled it
   * — so `_very_` reached the page as literal underscores in Book, Stage, VN
   * and the HTML export while Storybook and Chat (which go through remark)
   * rendered it correctly. Prose people paste is full of it, and the dialogue
   * pass in `textProcessor` deliberately rewrites emphasis INSIDE speech to the
   * underscore form, so every emphasised word in a line of dialogue was showing
   * its markers.
   *
   * Intraword underscores are left alone, per CommonMark: `snake_case_name` is
   * an identifier, not emphasis, and the `*` rules above have no equivalent
   * hazard.
   */
  s = s.replace(/(^|[^\w\\])___([^_\n]+)___(?![\w])/g, '$1<strong><em>$2</em></strong>');
  s = s.replace(/(^|[^\w\\])__([^_\n]+)__(?![\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w\\])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>');
  // Dialogue (straight or curly quotes) gets its own class so themes can
  // tint speech without touching narration.
  s = s.replace(/(["“])([^"“”\n]+)(["”])/g,
    (_m, o, body, c) => `<span class="book-say">${o}${body}${c}</span>`);
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\uE000(\d+)\uE001/g, (_m, i) => guarded[Number(i)]);
};

/** Sentence-boundary split used to break paragraphs too tall for one page. */
const splitSentences = (text: string): string[] =>
  text.match(/[^.!?…]+[.!?…]+["”’)]?\s*|[^.!?…]+$/g) ?? [text];

/** Pre-split a paragraph so no single block can outgrow a page. */
const chunkParagraph = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let cur = '';
  for (const sent of splitSentences(text)) {
    if (cur && cur.length + sent.length > maxChars) { out.push(cur.trim()); cur = ''; }
    cur += sent;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
};

export interface ChapterInfo {
  title: string;
  subtitle?: string;
  /** Mood accent for the ornament rule. */
  color?: string;
}

/** A chapter opening: ornament, numbered title, optional place/mood line. */
export const chapterBlock = (ch: ChapterInfo): string =>
  `<div class="book-chapter">` +
  `<div class="book-orn" style="--orn:${ch.color ?? 'currentColor'}">❦</div>` +
  `<div class="book-chapter-title">${escapeHtml(ch.title)}</div>` +
  (ch.subtitle ? `<div class="book-chapter-sub">${escapeHtml(ch.subtitle)}</div>` : '') +
  `</div>`;

/** A typographic scene break inside a chapter. */
export const sceneBreakBlock = (): string =>
  `<div class="book-break" aria-hidden="true">✦&ensp;✦&ensp;✦</div>`;

/** A full-width plate for an image ATTACHED to a message (msg.images). */
export const attachedPlateBlock = (src: string, messageId: string): BookBlock => ({
  html: `<div class="book-plate" data-msg="${messageId}">` +
    `<img src="${src.replace(/"/g, '&quot;')}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`,
  messageId,
});

export const paragraphBlocks = (
  processedText: string,
  messageId: string,
  isUser: boolean,
  maxChars: number,
  showImages = true,
): BookBlock[] => {
  const blocks: BookBlock[] = [];
  for (const rawPara of processedText.split(/\n{2,}/)) {
    const para = rawPara.trim();
    if (!para) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(para)) {
      blocks.push({ html: sceneBreakBlock(), messageId });
      continue;
    }
    // Headings inside prose (rare) render as small chapter-ish heads.
    const heading = /^#{1,4}\s+(.*)$/.exec(para);
    if (heading) {
      blocks.push({ html: `<div class="book-head">${renderInline(heading[1])}</div>`, messageId });
      continue;
    }
    for (const chunk of chunkParagraph(para, maxChars)) {
      const html = renderInline(chunk, { images: showImages });
      if (!html.trim()) continue; // e.g. an image-only paragraph with images off
      blocks.push({
        html: `<p class="book-para${isUser ? ' book-user' : ''}" data-msg="${messageId}">${html}</p>`,
        messageId,
      });
    }
  }
  return blocks;
};

/**
 * Flow blocks into pages of `pageH` using `measurer` — an attached, hidden
 * element already styled and sized like a page body.
 *
 * All blocks are laid out in ONE continuous column and measured in a single
 * pass (one reflow total — a per-block append/measure loop would thrash
 * layout and take seconds on long stories). Page cuts fall where a block's
 * bottom would pass the page height; the candidate page-opener's own top
 * margin is added because margins don't collapse through the page padding.
 */
export const paginate = (
  measurer: HTMLElement,
  blocks: BookBlock[],
  pageH: number,
): { pages: BookPage[]; lastFree: number } => {
  measurer.innerHTML = '';
  const frag = document.createDocumentFragment();
  const els: HTMLElement[] = [];
  const kept: BookBlock[] = [];
  for (const block of blocks) {
    const tpl = document.createElement('template');
    tpl.innerHTML = block.html;
    const el = tpl.content.firstElementChild as HTMLElement | null;
    if (!el) continue;
    els.push(el);
    kept.push(block);
    frag.appendChild(el);
  }
  measurer.appendChild(frag);
  if (!els.length) { measurer.innerHTML = ''; return { pages: [], lastFree: pageH }; }

  // Single measurement pass: layout happens once, then reads are cached.
  const tops = els.map(el => el.offsetTop);
  const bottoms = els.map(el => el.offsetTop + el.offsetHeight);
  const marginTops = els.map(el => parseFloat(getComputedStyle(el).marginTop) || 0);
  measurer.innerHTML = '';

  const pages: BookPage[] = [];
  let chapter: string | undefined;
  let start = 0;
  const closePage = (end: number) => {
    const cur = kept.slice(start, end);
    pages.push({ blocks: cur, chapter });
    // The running head shows the chapter you are IN, so a chapter that
    // opens mid-page takes over from the next page onward.
    chapter = cur.reduce<string | undefined>((c, b) => b.chapter ?? c, chapter);
    start = end;
  };
  for (let i = 0; i < els.length; i++) {
    const used = bottoms[i] - tops[start] + marginTops[start];
    if (used > pageH && i > start) closePage(i);
  }
  const lastFree = Math.max(
    0, pageH - (bottoms[els.length - 1] - tops[start] + marginTops[start]),
  );
  closePage(els.length);
  return { pages, lastFree };
};

/**
 * Continue pagination for the live streaming tail: refill the last committed
 * page and flow the tail after it. Only the tail is re-measured per tick.
 */
export const paginateTail = (
  measurer: HTMLElement,
  lastPage: BookPage | undefined,
  tail: BookBlock[],
  pageH: number,
): BookPage[] => {
  const { pages } = paginate(measurer, [...(lastPage?.blocks ?? []), ...tail], pageH);
  if (lastPage) for (const p of pages) p.chapter ??= lastPage.chapter;
  return pages;
};

/**
 * Wrap the words of the LAST paragraph in spans so freshly streamed words can
 * materialize with the ink animation while settled words stay still.
 * Returns the rewritten page html and the new total word count of that tail.
 */
export const inkWrapTail = (
  pageHtml: string,
  settledWords: number,
): { html: string; totalWords: number } => {
  const tpl = document.createElement('template');
  tpl.innerHTML = pageHtml;
  const paras = tpl.content.querySelectorAll('p.book-para');
  const last = paras[paras.length - 1];
  if (!last) return { html: pageHtml, totalWords: settledWords };

  let word = 0;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? '').split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
        const span = document.createElement('span');
        if (word >= settledWords) {
          span.className = 'book-ink';
          span.style.animationDelay = `${Math.min((word - settledWords) * 60, 480)}ms`;
        }
        span.textContent = part;
        frag.appendChild(span);
        word++;
      }
      (node as ChildNode).replaceWith(frag);
      return;
    }
    // Copy childNodes first — wrapping mutates the list while walking.
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(last);
  return { html: tpl.innerHTML, totalWords: word };
};
