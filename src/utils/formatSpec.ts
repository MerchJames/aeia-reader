/**
 * Turning a form the reader already has into a form the model will fill in.
 *
 * The long read's whole trick is that the document's SHAPE is authored once and
 * restated on every pass, so a twenty-pass read comes out as one document
 * rather than twenty stapled together. That shape has so far had to be typed
 * into a textarea. But readers already have their forms — an anatomy chart, a
 * stat block, a location sheet — sitting in a JSON file, an XML fragment, a
 * markdown template, or just pasted out of somewhere else.
 *
 * So: take that, whatever it is, and make it the format.
 *
 * ── The one property that matters ──────────────────────────────────────────
 *
 * **The reader's own form comes back out.** Not a paraphrase of it, not a
 * cleaned-up version, not the model's idea of what an anatomy chart looks like.
 * The literal template is embedded in the instruction and restated verbatim on
 * every pass, because the reason to upload a form is that you want *that* form.
 * `renderFormatInstruction` therefore always contains the source text, and the
 * tests assert it character for character.
 *
 * What parsing adds is a FIELD LIST — the keys, in order, with their nesting.
 * That is worth having because a model handed a bare JSON blob will often
 * return prose about the blob; handed "these are the fields, here is the
 * skeleton, fill it in", it fills it in.
 *
 * Pure: no store, no React, no fetch.
 */

/** What the reader pasted. Detected, never asked. */
export type FormatKind = 'json' | 'xml' | 'markdown' | 'outline' | 'plain';

export interface FormatField {
  /** Dotted path for a nested key: `anatomy.limbs`. */
  path: string;
  /** Nesting depth, 0 for a top-level field. */
  depth: number;
  /** True when the source had a list here rather than a single value. */
  list: boolean;
  /** Anything the reader wrote as the value — often an instruction to the model. */
  hint?: string;
}

export interface FormatSpec {
  kind: FormatKind;
  /** Best guess at what the document is called. '' when there is nothing to go on. */
  title: string;
  fields: FormatField[];
  /** The reader's text, untouched. */
  template: string;
}

/** Beyond this a "format" is a document, not a form. */
export const MAX_TEMPLATE_CHARS = 8000;
/** Deeper than this and the field list is noise rather than a map. */
export const MAX_DEPTH = 4;
export const MAX_FIELDS = 120;

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export const detectFormatKind = (text: string): FormatKind => {
  const t = text.trim();
  if (!t) return 'plain';
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch { /* fall through — a near-miss is not JSON */ }
  }
  if (/^<[a-zA-Z_][\w:.-]*[\s>]/.test(t) && /<\/[a-zA-Z_][\w:.-]*>\s*$/.test(t)) return 'xml';
  if (/^#{1,6}\s/m.test(t)) return 'markdown';
  // A line ending in a colon with nothing after it is somebody writing a form
  // by hand — "Name:", "Weaknesses:" — which is a shape even though it is not
  // a syntax.
  if (/^[^\n:]{1,60}:\s*$/m.test(t)) return 'outline';
  return 'plain';
};

/* ------------------------------------------------------------------ */
/* Parsing each kind into fields                                       */
/* ------------------------------------------------------------------ */

const pushField = (out: FormatField[], f: FormatField) => {
  if (out.length < MAX_FIELDS) out.push(f);
};

const walkJson = (value: unknown, out: FormatField[], prefix = '', depth = 0): void => {
  if (depth > MAX_DEPTH || out.length >= MAX_FIELDS) return;
  if (Array.isArray(value)) {
    // The array itself was already recorded by the caller as `list: true`. Its
    // first element describes the shape of one entry, if there is one.
    if (value.length && typeof value[0] === 'object' && value[0] !== null) {
      walkJson(value[0], out, prefix, depth);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const list = Array.isArray(child);
    const hint = typeof child === 'string' && child.trim() ? child.trim()
      : list && typeof (child as unknown[])[0] === 'string' ? String((child as unknown[])[0])
        : undefined;
    pushField(out, { path, depth, list, hint });
    walkJson(child, out, path, depth + 1);
  }
};

const parseXmlFields = (text: string): FormatField[] => {
  const out: FormatField[] = [];
  const stack: string[] = [];
  // Deliberately a scanner rather than DOMParser: this runs in a worker-free
  // pure module, the input is a fragment as often as a document, and a
  // half-written form should still yield its field names.
  const tag = /<(\/?)([a-zA-Z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let pendingText = '';
  while ((m = tag.exec(text)) !== null) {
    const [, closing, name, , selfClose, textRun] = m;
    if (textRun !== undefined) { pendingText = textRun.trim(); continue; }
    if (closing) {
      const path = stack.join('.');
      const field = out.find(f => f.path === path);
      if (field && pendingText && !field.hint) field.hint = pendingText;
      stack.pop();
      pendingText = '';
      continue;
    }
    if (stack.length <= MAX_DEPTH) {
      stack.push(name);
      const path = stack.join('.');
      // A repeated sibling is a list — <limb/><limb/> means "one per limb".
      const existing = out.find(f => f.path === path);
      if (existing) existing.list = true;
      else pushField(out, { path, depth: stack.length - 1, list: false });
    }
    if (selfClose) stack.pop();
    pendingText = '';
  }
  // The document element is a wrapper, not a field, when everything hangs off it.
  const roots = out.filter(f => f.depth === 0);
  if (roots.length === 1) {
    const root = roots[0].path;
    return out
      .filter(f => f.path !== root)
      .map(f => ({ ...f, path: f.path.slice(root.length + 1), depth: f.depth - 1 }));
  }
  return out;
};

const parseHeadingFields = (text: string): FormatField[] => {
  const out: FormatField[] = [];
  const stack: string[] = [];
  for (const line of text.split('\n')) {
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!h) continue;
    const depth = Math.min(h[1].length - 1, MAX_DEPTH);
    const name = h[2].replace(/[:#]+$/, '').trim();
    stack.length = depth;
    stack[depth] = name;
    pushField(out, { path: stack.filter(Boolean).join('.'), depth, list: false });
  }
  // A single top heading is the document's title, not one of its fields.
  const tops = out.filter(f => f.depth === 0);
  if (tops.length === 1 && out.length > 1) {
    const root = tops[0].path;
    return out.filter(f => f.path !== root)
      .map(f => ({ ...f, path: f.path.startsWith(`${root}.`) ? f.path.slice(root.length + 1) : f.path, depth: Math.max(0, f.depth - 1) }));
  }
  return out;
};

const parseOutlineFields = (text: string): FormatField[] => {
  const out: FormatField[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\s*)(?:[-*+]\s*)?([^:\n]{1,60}):\s*(.*)$/.exec(line);
    if (!m) continue;
    const depth = Math.min(Math.floor(m[1].length / 2), MAX_DEPTH);
    pushField(out, {
      path: m[2].trim(),
      depth,
      list: /^[-*+]/.test(line.trim()),
      hint: m[3].trim() || undefined,
    });
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* The whole thing                                                     */
/* ------------------------------------------------------------------ */

/** Best guess at what this form is called, for naming the pin. */
const titleOf = (text: string, kind: FormatKind, fields: FormatField[]): string => {
  if (kind === 'markdown') {
    const h1 = /^#\s+(.+?)\s*$/m.exec(text);
    if (h1) return h1[1].trim();
  }
  if (kind === 'xml') {
    const root = /^<([a-zA-Z_][\w:.-]*)/.exec(text.trim());
    if (root) return root[1].replace(/[_-]+/g, ' ').trim();
  }
  if (kind === 'json') {
    // `{"anatomy": {...}}` — one key at the top, with everything under it, is a
    // wrapper naming the document rather than a field of it.
    const roots = fields.filter(f => f.depth === 0);
    if (roots.length === 1 && fields.length > 1) return roots[0].path.replace(/[_-]+/g, ' ');
  }
  return '';
};

export const parseFormat = (text: string): FormatSpec => {
  const template = text.slice(0, MAX_TEMPLATE_CHARS);
  const kind = detectFormatKind(template);
  let fields: FormatField[] = [];
  if (kind === 'json') {
    try { walkJson(JSON.parse(template.trim()), fields); } catch { fields = []; }
  } else if (kind === 'xml') fields = parseXmlFields(template);
  else if (kind === 'markdown') fields = parseHeadingFields(template);
  else if (kind === 'outline') fields = parseOutlineFields(template);
  return { kind, title: titleOf(template, kind, fields), fields, template };
};

/**
 * The format instruction handed to the long read, restated on every pass.
 *
 * Three parts, in this order for a reason. The rule first, because a model that
 * reads the template before it reads "reproduce this exactly" starts improving
 * it. Then the literal template. Then the field list, which is a checklist
 * rather than a description — the failure it prevents is a model filling in the
 * four fields it found interesting and silently dropping the other nine.
 */
export const renderFormatInstruction = (spec: FormatSpec): string => {
  if (!spec.template.trim()) return '';
  const lines: string[] = [
    'Produce the document in EXACTLY the form below. Reproduce its structure,'
    + ' its field names and its punctuation as given — do not rename a field, do'
    + ' not add one, do not drop one, and do not reorder them.',
  ];
  if (spec.kind === 'json') {
    lines.push('The output is JSON in this shape. Replace the placeholder values, keep every key.');
  } else if (spec.kind === 'xml') {
    lines.push('The output is XML in this shape. Replace the element contents, keep every tag.');
  }
  lines.push('', 'FORM:', spec.template.trim(), '');
  if (spec.fields.length) {
    lines.push(
      'Every field must appear, filled in from the story or marked "unknown" when the'
      + ' story does not say:',
      ...spec.fields.map(f =>
        `${'  '.repeat(f.depth)}- ${f.path}${f.list ? ' (one entry per item)' : ''}`
        + (f.hint ? ` — ${f.hint}` : '')),
    );
  }
  return lines.join('\n');
};

/**
 * Why a pasted format cannot be used, or null when it can.
 *
 * "Unknown shape" is not on the list. A form the parser cannot read is still a
 * form: the template is restated verbatim regardless, and the field list is an
 * extra, not a requirement. Refusing plain text here would reject the most
 * obvious thing a reader will paste.
 */
export const formatProblem = (text: string): string | null => {
  const t = text.trim();
  if (!t) return 'Paste or drop a form first.';
  if (t.length > MAX_TEMPLATE_CHARS) {
    return `That is ${t.length.toLocaleString()} characters. A form has to be restated on every`
      + ` pass, so it must stay under ${MAX_TEMPLATE_CHARS.toLocaleString()} — trim it to the shape,`
      + ' without the example content.';
  }
  return null;
};

/** One line describing what was understood, for the panel to show back. */
export const describeFormat = (spec: FormatSpec): string => {
  const kindWord = spec.kind === 'outline' ? 'form' : spec.kind;
  if (!spec.fields.length) {
    return `Read as ${kindWord}. No named fields found — the form will be restated as written.`;
  }
  const n = spec.fields.length;
  return `Read as ${kindWord}: ${n} field${n === 1 ? '' : 's'}${spec.title ? ` under “${spec.title}”` : ''}.`;
};
