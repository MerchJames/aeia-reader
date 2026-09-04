import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Combine, Copy, Loader2, Pencil, Plus, RefreshCw,
  GripVertical, ListOrdered, Lock, LockOpen, Maximize2, Pin, ScrollText, Send,
  PlugZap, SlidersHorizontal, Sparkles, Square, Trash2, Wand2, Wrench, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import {
  candidateBases, chatCompletion, chatCompletionStream, ChatMsg, isLocalBase,
  listModels, mergeSamplers, samplerParamsFrom,
} from '../utils/aiClient';
import { cardToPromptBlock, pinsToPromptBlock, sheetsToPromptBlock } from '../utils/cardContext';
import { describeSuccess, diagnose } from '../utils/aiDiagnose';
import { cn } from '../utils/cn';
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { buildZoneBody, flatWithIndex, zoneSummary } from '../utils/contextZone';
import { buildVisitorTurnMessages, visitorsToPromptBlock } from '../utils/visitor';
import { arcsBefore, throughlineBlock, throughlineFor } from '../utils/throughline';
import { ThroughlinePanel } from './ThroughlinePanel';
import { askText } from '../utils/aiCall';
import { getStory } from '../lib/storage';
import type { CardInfo } from '../types';
import { resolveContent } from '../utils/lens';
import { buildCowritePayload } from '../utils/cowrite';
import { narrativeBlocksFor, renderNarrativeBlocks } from '../utils/narrativeBlocks';
import { castOf } from '../utils/askCharacter';
import { ContextZoneBuilder } from './ContextZoneBuilder';
import { VisitorPanel } from './VisitorPanel';
import { CowritePanel } from './CowritePanel';
import { SummarizePanel } from './SummarizePanel';
import { TaskPanel } from './TaskPanel';
import { runAgentTurn, workingBudget } from '../utils/agentLoop';
import { renderToolCatalog } from '../utils/agentTools';
import { buildToolContext } from '../hooks/useAgentTools';
import { usePanelDock } from '../hooks/usePanelDock';
import { useIsMobile } from '../hooks/useMediaQuery';
import { dockStyle, PRESET_LABEL, presetDock, type DockPreset } from '../utils/panelDock';
import { LensEditModal, type LensPick } from './LensEditModal';
import { ProposalReview } from './ProposalReview';
import {
  makeProposal, pendingProposals, proposalProblem, queueProposal, settleProposal,
  trimProposals, type LensProposal,
} from '../utils/lensProposal';
import {
  armDirective, armIncomplete, armLabel, armPlaceholder, armScopeLabel,
  clampTargets, type ArmedTool,
} from '../utils/toolArm';
import { AiAdvancedConfig, CardInfo as Card, ChatToolStep, ChatTurn, CowriteRunSpec, Message, VisitorTurnSpec } from '../types';

type Scope = 'page' | 'here' | 'all' | 'swipes' | 'zones';

/** Stable empty index so the lazy `flat` memo doesn't churn when Lens is idle. */
const NO_FLAT: ReturnType<typeof flatWithIndex> = [];

interface ContextOpts {
  scope: Scope;
  includeHighlights: boolean;
  focusCharacter: string;
  /** Active Context Zone id (only used when scope === 'zones'). */
  zoneId?: string;
}

/**
 * Gather the transcript for the chosen scope, resolving the live streaming text.
 *
 * Message ids ride along because a visitor's turn needs the same scene the
 * reader chose, in a form `clampHistory` can budget — and inventing ids for it
 * would let a clamp silently fail open, which for this feature means handing a
 * stranger the end of the story.
 */
const collectTranscript = (scope: Scope): { id: string; name: string; content: string }[] => {
  const { chains, currentChainIndex, currentMessageIndex, streamingMessage, streamedText } = useAppStore.getState();
  const text = (m: { id: string; content: string }) =>
    m.id === streamingMessage?.id ? streamedText : m.content;

  if (scope === 'page') {
    return (chains[currentChainIndex]?.messages ?? []).map(m => ({ id: m.id, name: m.name, content: text(m) }));
  }
  if (scope === 'swipes') {
    // Every alternate version (swipe) of the message the reader is sitting on —
    // for comparing, summarizing across, or picking the best take.
    const m = chains[currentChainIndex]?.messages?.[currentMessageIndex];
    if (!m) return [];
    const variants = m.swipes && m.swipes.length > 1 ? m.swipes : [m.content];
    return variants.map((v, i) => ({ id: `${m.id}#${i}`, name: `${m.name} — version ${i + 1}`, content: v }));
  }
  const flat: { id: string; name: string; content: string }[] = [];
  outer: for (let ci = 0; ci < chains.length; ci++) {
    for (let mi = 0; mi < chains[ci].messages.length; mi++) {
      const m = chains[ci].messages[mi];
      flat.push({ id: m.id, name: m.name, content: text(m) });
      if (scope === 'here' && ci === currentChainIndex && mi === currentMessageIndex) break outer;
    }
  }
  return flat;
};

// Hard ceiling only to avoid a pathological multi-MB request that no model
// could accept — the whole story is sent below this (~1M chars ≈ 250k tokens).
const MAX_CHARS = 1_000_000;


/** Build the system prompt for the assistant from the reader's chosen options. */
const buildContext = (opts: ContextOpts): string => {
  const s = useAppStore.getState();
  const { currentStory, chains, streamingMessage, streamedText } = s;
  const total = chains.reduce((n, c) => n + c.messages.length, 0);
  const resolve = (m: { id: string; content: string }) =>
    m.id === streamingMessage?.id ? streamedText : m.content;

  let body: string;
  let scopeLine: string;

  if (opts.scope === 'zones') {
    const zone = opts.zoneId
      ? useAuraV2Store.getState().zonesByStory[currentStory?.id ?? '']?.find(z => z.id === opts.zoneId)
      : undefined;
    if (!zone) {
      body = '(No context zone selected.)';
      scopeLine = 'The reader has not selected a context zone yet.';
    } else {
      const built = buildZoneBody(zone, chains, resolve, currentStory?.timelines ?? []);
      body = built.empty ? '(The selected context zone is empty.)' : built.body;
      scopeLine = built.empty
        ? `The reader's context zone "${zone.name}" is currently empty.`
        : `You are given a reader-curated CONTEXT ZONE named "${zone.name}" — a hand-picked selection of ${built.messageCount} message${built.messageCount === 1 ? '' : 's'}${built.branchlineCount ? ` plus the full alternate versions (branchlines) of ${built.branchlineCount} message${built.branchlineCount === 1 ? '' : 's'}` : ''}. Work only from what it contains. The selection may be non-contiguous, so do not assume anything about gaps between the passages shown.`;
    }
  } else {
    const flat = collectTranscript(opts.scope);
    body = flat.map(m => `${m.name}: ${m.content}`).join('\n\n');
    const branchChar = flat[0]?.name?.split(' — ')[0] ?? 'a character';
    scopeLine =
      opts.scope === 'all' ? 'You can see the ENTIRE story.'
      : opts.scope === 'page' ? 'You can see only the CURRENT page.'
      : opts.scope === 'swipes'
        ? `You are comparing ALL ${flat.length} alternate version${flat.length === 1 ? '' : 's'} (swipes) of a SINGLE message from "${branchChar}". Each is labeled "version N" below. Help the reader compare them, summarize across them, or judge which reads best — no wider story is provided.`
      : `You can see the story up to the reader's position (message ${flat.length} of ${total}). Do not invent or spoil events beyond it.`;
  }

  // Trim the transcript to fit. The reader's context-size budget (if set) wins,
  // minus a rough reserve for the model's own reply; otherwise the safety ceiling.
  const adv = s.aiAdvanced;
  const cap = adv.contextSize > 0
    ? Math.max(2000, adv.contextSize * 4 - Math.max(0, adv.maxTokens) * 4)
    : MAX_CHARS;
  if (body.length > cap) body = `…(earliest text omitted to fit)…\n\n${body.slice(body.length - cap)}`;

  // Reader's highlights + notes.
  const highlights = currentStory?.highlights ?? [];
  const highlightBlock = opts.includeHighlights && highlights.length
    ? [
        '',
        "--- READER'S HIGHLIGHTS & NOTES ---",
        ...highlights.map(h => `• "${h.text}"${h.note ? ` — note: ${h.note}` : ''}`),
      ].join('\n')
    : '';

  // Pinnable tracking sheets (shared serializer with scoped threads).
  const sheetsBlock = currentStory
    ? sheetsToPromptBlock(useAuraV2Store.getState().sheetsByStory[currentStory.id])
    : '';
  const sheetBlock = sheetsBlock ? `\n${sheetsBlock}` : '';

  // Pinned visuals the reader marked "include in context".
  const pinsBlock = currentStory
    ? pinsToPromptBlock(useAuraV2Store.getState().pinsByStory[currentStory.id])
    : '';
  const pinBlock = pinsBlock ? `\n${pinsBlock}` : '';

  const focus = opts.focusCharacter.trim();
  const focusBlock = focus
    ? `\nThe reader is focused on the character "${focus}". Prioritize their actions, voice, motivations, and arc. If asked to write as them, match their established speech and personality from the text.`
    : '';

  // Attached character card: author-written description/personality/lorebook
  // gives the assistant ground truth beyond the transcript itself.
  const cardBlock = cardToPromptBlock(currentStory?.card);

  // Characters the reader has brought in from other chats. Placed AFTER the
  // story text, in the high-attention tail, and fenced with its own header and
  // footer — a brief that bleeds into the transcript reads as part of it, which
  // is exactly the confusion the whole dossier design exists to prevent.
  const visitorBlock = currentStory
    ? visitorsToPromptBlock(
      useAuraV2Store.getState().visitorsByStory[currentStory.id],
      currentStory.characterName,
    )
    : '';

  /**
   * Who the reader is playing, and what has already happened to them elsewhere.
   *
   * Placed BEFORE the story text, unlike the visitor block: a visitor is
   * somebody arriving into this scene and belongs in the high-attention tail,
   * while the protagonist is who the reader has been all along and reads as
   * setup. It is also clamped — only arcs ordered before this one — so it can
   * never hand the model the end of a story the reader has not reached.
   */
  const spineBlock = currentStory
    ? throughlineBlock(
      throughlineFor(useAuraV2Store.getState().throughlines, currentStory.id),
      currentStory.id,
      currentStory.characterName,
    )
    : '';

  const assembled = [
    `You are a reading assistant embedded in "Aeia Reader", helping the reader with a story / roleplay chat titled "${currentStory?.title ?? 'Untitled'}".`,
    currentStory?.characterName ? `Main character: ${currentStory.characterName}.` : '',
    currentStory?.userName ? `The reader's own persona in this story is "${currentStory.userName}".` : '',
    scopeLine,
    `Help them summarize, recap, explain, discuss, synthesize, or write in-character — using ONLY the material below. Reply in markdown; LaTeX in $…$ / $$…$$ is supported.`,
    focusBlock,
    cardBlock ? `\n${cardBlock}` : '',
    spineBlock ? `\n${spineBlock}` : '',
    '',
    '--- STORY TEXT ---',
    body,
    highlightBlock,
    sheetBlock,
    pinBlock,
    visitorBlock ? `\n${visitorBlock}` : '',
  ].filter(Boolean).join('\n');

  // Advanced overrides: an optional persona/system prompt and a custom context
  // template. When a template with {{content}} is supplied it wraps everything;
  // otherwise the reader's system prompt is simply prepended.
  const sys = adv.systemPrompt.trim();
  const tpl = adv.contextTemplate.trim();
  if (tpl && /\{\{\s*content\s*\}\}/.test(tpl)) {
    return tpl
      .replace(/\{\{\s*content\s*\}\}/g, assembled)
      .replace(/\{\{\s*system\s*\}\}/g, sys);
  }
  return sys ? `${sys}\n\n${assembled}` : assembled;
};

/**
 * Cheap character-count estimate for the size readout. buildContext allocates
 * and joins the full prompt (transcript up to ~1M chars + pinned visuals up to
 * ~200k) — far too heavy to run on mount and every keystroke just to show a
 * token count. This sums lengths instead: no multi-MB string is ever built, so
 * the panel stays responsive. It's an approximation (a few hundred chars of
 * scaffolding aren't modeled), which is all the readout needs.
 */
const estimateContextChars = (opts: ContextOpts): number => {
  const s = useAppStore.getState();
  const { currentStory, chains, currentChainIndex, currentMessageIndex, streamingMessage, streamedText } = s;
  // Zones and Branchline are hand-picked and small — the real builder is cheap.
  if (opts.scope === 'zones' || opts.scope === 'swipes') return buildContext(opts).length;

  const adv = s.aiAdvanced;
  const cap = adv.contextSize > 0
    ? Math.max(2000, adv.contextSize * 4 - Math.max(0, adv.maxTokens) * 4)
    : MAX_CHARS;
  const clen = (m: { id: string; content: string }) =>
    (m.id === streamingMessage?.id ? streamedText.length : m.content.length);

  let body = 0;
  if (opts.scope === 'page') {
    for (const m of chains[currentChainIndex]?.messages ?? []) body += m.name.length + clen(m) + 4;
  } else {
    outer: for (let ci = 0; ci < chains.length; ci++) {
      const msgs = chains[ci].messages;
      for (let mi = 0; mi < msgs.length; mi++) {
        body += msgs[mi].name.length + clen(msgs[mi]) + 4;
        if (opts.scope === 'here' && ci === currentChainIndex && mi === currentMessageIndex) break outer;
      }
    }
  }
  if (body > cap) body = cap;

  // Bounded extras — summed, not built (only the small card block is materialized).
  let extra = 0;
  if (opts.includeHighlights) {
    for (const h of currentStory?.highlights ?? []) extra += h.text.length + (h.note?.length ?? 0) + 12;
  }
  const v2 = useAuraV2Store.getState();
  const sid = currentStory?.id ?? '';
  let pinBudget = 200_000;
  for (const p of (v2.pinsByStory[sid] ?? []).filter(p => p.inContext).slice(0, 6)) {
    const l = Math.min(p.content.length, pinBudget);
    extra += l + p.title.length + 6;
    pinBudget -= l;
  }
  for (const sh of (v2.sheetsByStory[sid] ?? []).slice(0, 6)) extra += Math.min(sh.rows.length, 60) * 48 + 48;
  extra += cardToPromptBlock(currentStory?.card).length;
  // Visitors are small and few; building the real block is cheaper than
  // approximating it, and keeps the readout exact for the one thing a reader
  // is most likely to wonder about the cost of.
  extra += visitorsToPromptBlock(v2.visitorsByStory[sid], currentStory?.characterName).length;
  // Counted too, so the size readout stays honest about what is actually sent.
  extra += throughlineBlock(
    throughlineFor(v2.throughlines, sid), sid, currentStory?.characterName,
  ).length;

  return body + extra + 700;
};

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'page', label: 'This page' },
  { value: 'here', label: 'Up to here' },
  { value: 'all', label: 'Whole story' },
  { value: 'swipes', label: 'Branchline' },
  { value: 'zones', label: 'Zones' },
];

const QUICK = [
  { label: 'Summarize', prompt: 'Give me a concise summary of the material you can see.' },
  { label: 'Recap last scene', prompt: 'Recap just the most recent scene in a few sentences.' },
  { label: 'Who is who?', prompt: 'List the characters that have appeared and one line about each.' },
  { label: 'Understand my character', prompt: "Analyze my persona's messages and choices. Summarize my character's personality, goals, voice, and how I've been playing them." },
  { label: 'Impersonate me', prompt: "Based on everything my persona has said and done, draft a reply for me at the current moment, written in my character's established voice." },
  { label: 'From my highlights', prompt: 'Using the passages I highlighted (and my notes), tie them together — what themes or throughline connect them?' },
];

// Shown only in Branchline scope, where the context is the swipes themselves.
const BRANCHLINE_QUICK = [
  { label: 'Which is best?', prompt: 'Compare these alternate versions of the same message. Which reads best and why? Rank them briefly.' },
  { label: 'Summarize across', prompt: 'Summarize what happens across all these versions — what stays constant and what differs between them?' },
  { label: 'Blend them', prompt: 'Draft a single version that combines the strongest parts of each alternate version, keeping the character\'s voice.' },
];

const Markdown = ({ children }: { children: string }) => (
  <div className="markdown-body">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {children}
    </ReactMarkdown>
  </div>
);

/**
 * The tool calls a turn made, folded away.
 *
 * Collapsed by default and stated as one line: the reader asked a question and
 * wants the answer, not a transcript of the lookups. Expanded it shows the
 * arguments and the result verbatim, because the one thing an agent must never
 * be is unauditable — a pin gained a version, and the reader is entitled to see
 * exactly what was asked for and what came back.
 */
const ToolSteps = ({ steps }: { steps: ChatToolStep[] }) => {
  const [open, setOpen] = useState(false);
  const failed = steps.filter(s => s.result.ok === false).length;
  return (
    <div className="max-w-[85%] mb-1 text-[11px]" data-testid="tool-steps">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-muted hover:text-app-text"
      >
        <Wrench size={11} />
        <span>
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {failed ? ` · ${failed} failed` : ''}
        </span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="rounded border border-app-border bg-app-text/5 px-2 py-1">
              <div className="flex items-center gap-1.5 font-mono">
                <span className={s.result.ok === false ? 'text-red-500' : 'text-accent'}>
                  {s.tool}
                </span>
                {s.result.ok === false && <span className="text-red-500">failed</span>}
              </div>
              {!!Object.keys(s.args).length && (
                <pre className="mt-0.5 whitespace-pre-wrap break-words opacity-70">
                  {JSON.stringify(s.args)}
                </pre>
              )}
              <pre className="mt-0.5 whitespace-pre-wrap break-words opacity-60">
                {JSON.stringify(s.result).slice(0, 600)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * A committed conversation turn.
 *
 * Every turn is editable, deletable and re-runnable, both roles. Editing your
 * own question and asking again is the cheapest steering there is, and editing
 * a reply is how a reader keeps a mostly-right answer they are about to build
 * on — the same reasoning that makes a Lens override an edit rather than a
 * regeneration. An edit rewrites the SHOWN variant only, so the swipes still
 * reach what the model actually said.
 */
const TurnView = React.memo(({
  turn, isLast, busy, onSwipe, onRegenerate, onEdit, onDelete, onRetry, onPin,
}: {
  turn: ChatTurn;
  isLast: boolean;
  busy: boolean;
  onSwipe: (dir: -1 | 1) => void;
  onRegenerate: () => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  /** Drop everything after this turn and generate again from it. */
  onRetry: () => void;
  /**
   * Keep this reply beside the story as a pin.
   *
   * The toolbar's pin button ARMS the next message — it tells the model that
   * what comes back should be a pin. This is the other half, and the one a
   * reader reaches for far more often: an answer that turned out to be worth
   * keeping, kept after the fact. Absent when there is no story open to keep
   * it against.
   */
  onPin?: (text: string) => void;
}) => {
  const content = turn.variants[turn.activeVariant] ?? turn.variants[0] ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);

  const startEdit = () => { setDraft(content); setEditing(true); };
  const commit = () => {
    if (draft.trim() && draft !== content) onEdit(draft);
    setEditing(false);
  };
  const copy = () => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => { /* a denied clipboard is not worth an error banner */ });
  };
  const many = turn.variants.length > 1;
  const isAssistant = turn.role === 'assistant';
  // Provenance, but only where it changes what the text IS: a visitor's voice,
  // a Lens draft, a cowrite. `scopeLabel` is set on ordinary replies too, and
  // stamping "Up to here" over every bubble would be noise rather than
  // information. A visitor's turn gets the accent, because a line written by a
  // character on loan from another chat must never read as the assistant's.
  const provenance = isAssistant && turn.scopeLabel
    && (turn.visitorSpec || turn.lensTargetId || turn.cowriteSpec)
    ? turn.scopeLabel : null;
  return (
    <div className={cn('group/turn flex flex-col', turn.role === 'user' ? 'items-end' : 'items-start')}>
      {provenance && (
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide mb-0.5 px-1',
            turn.visitorSpec ? 'text-accent font-bold' : 'text-muted',
          )}
          data-testid="turn-provenance"
        >
          {provenance}
        </span>
      )}
      {isAssistant && !!turn.toolSteps?.length && <ToolSteps steps={turn.toolSteps} />}
      {editing ? (
        // Full width while editing, whichever side the bubble sits on: an 85%
        // box aligned right is a miserable thing to type a paragraph into.
        <div className="w-full">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
            }}
            autoFocus
            rows={Math.min(16, Math.max(3, draft.split('\n').length + 1))}
            className="w-full text-sm rounded-xl border border-app-border bg-app-surface px-3 py-2 resize-y"
            data-testid="turn-editor"
          />
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={commit}
              className="text-xs px-2.5 py-1 rounded-full bg-accent text-white"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-2.5 py-1 rounded-full border border-app-border hover:bg-app-text/5"
            >
              Cancel
            </button>
            <span className="text-[10px] text-muted">⌘/Ctrl + Enter saves · Esc cancels</span>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm',
            turn.role === 'user'
              ? 'bg-accent text-white rounded-br-sm'
              : 'bg-app-text/5 border border-app-border rounded-bl-sm',
          )}
        >
          {isAssistant ? <Markdown>{content}</Markdown> : <span className="whitespace-pre-wrap">{content}</span>}
        </div>
      )}
      {!editing && (
        // The row is always in the DOM and fades in on hover, rather than being
        // mounted on hover: a control that appears on hover cannot be reached
        // on a touch screen at all, and this panel is used on tablets.
        <div
          className={cn(
            'flex items-center gap-0.5 mt-1 text-muted transition-opacity',
            'opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100 touch:opacity-100',
          )}
        >
          {isAssistant && many && (
            <>
              <button
                onClick={() => onSwipe(-1)}
                disabled={turn.activeVariant === 0}
                className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
                title="Previous version"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="text-[10px] font-mono tabular-nums">{turn.activeVariant + 1}/{turn.variants.length}</span>
              <button
                onClick={() => onSwipe(1)}
                disabled={turn.activeVariant === turn.variants.length - 1}
                className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
                title="Next version"
              >
                <ChevronRight size={13} />
              </button>
            </>
          )}
          {isAssistant && isLast && (
            <button
              onClick={onRegenerate}
              disabled={busy}
              className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
              title="Regenerate — get another version (swipe)"
            >
              <RefreshCw size={12} />
            </button>
          )}
          {!isLast && (
            <button
              onClick={onRetry}
              disabled={busy}
              className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-30"
              title={isAssistant
                ? 'Answer again from here — drops the turns below'
                : 'Ask again from here — drops the turns below'}
              data-testid="turn-retry"
            >
              <RefreshCw size={12} />
            </button>
          )}
          <button
            onClick={startEdit}
            className="p-0.5 rounded hover:bg-app-text/10"
            title="Edit this message"
            data-testid="turn-edit"
          >
            <Pencil size={12} />
          </button>
          <button onClick={copy} className="p-0.5 rounded hover:bg-app-text/10" title="Copy">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          {onPin && isAssistant && (
            <button
              onClick={() => { onPin(content); setPinned(true); setTimeout(() => setPinned(false), 1400); }}
              className={cn('p-0.5 rounded hover:bg-app-text/10', pinned && 'text-accent')}
              title="Keep this reply as a pin"
              data-testid="turn-pin"
            >
              {pinned ? <Check size={12} /> : <Pin size={12} />}
            </button>
          )}
          <button
            onClick={onDelete}
            disabled={busy}
            className="p-0.5 rounded hover:bg-app-text/10 hover:text-red-500 disabled:opacity-30"
            title="Delete this message"
            data-testid="turn-delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}, (a, b) => a.turn === b.turn && a.isLast === b.isLast && a.busy === b.busy
  && a.onPin === b.onPin);

/** Number input that maps an empty field to `null` ("use server default"). */
const NumField = ({
  label, value, onChange, step = 0.05, min, max, placeholder = 'default',
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) => (
  <label className="flex items-center justify-between gap-2 text-xs">
    <span className="text-muted">{label}</span>
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value == null ? '' : value}
      onChange={(e) => { const v = e.target.value; onChange(v === '' ? null : Number(v)); }}
      placeholder={placeholder}
      className="w-24 bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50"
    />
  </label>
);

/**
 * Advanced generation controls. Deliberately tucked behind the sliders button
 * and rendered as an overlay so the default panel stays simple — most readers
 * never open this.
 */

/**
 * What the guide is FOR, in the model's own instructions.
 *
 * The tool catalogue says what it can do; this says what it should be like.
 * Separate because the two change for different reasons, and because this is
 * the part a reader would recognise as tone rather than capability.
 *
 * The two rules that matter: look it up before saying it, and take them there
 * rather than describing the journey. A guide that recites a click path from
 * memory is worse than no guide, because it is confidently wrong about an app
 * the reader cannot check it against.
 */
const GUIDE_BRIEF = [
  '--- YOU ARE ALSO THE TOUR GUIDE ---',
  'The reader has switched this on because the app has more in it than is',
  'obvious. Your job is to make it navigable.',
  '',
  '- Look things up with guide.docs before you explain them. The manual is the',
  '  truth about this app; your memory is not. If it is not in there, say you',
  '  are not sure rather than inventing a menu.',
  '- Prefer taking them there to telling them where it is. One app.goto beats a',
  '  paragraph of directions — but say what you are about to do first.',
  '- Call guide.where when they say "this", "here", or "the current one".',
  '- Answer the question they asked, then stop. This is a guide, not a tour that',
  '  runs whether or not anyone is following.',
  '- You can change their display settings, and you cannot change anything about',
  '  their AI endpoint, their syncing, or their data. For those, open the panel',
  '  and say which control to look at.',
  '- Everything AI here is optional and has a working AI-free path. If someone',
  '  is stuck on connecting a model, remember that they can use the whole app',
  '  without one.',
].join('\n');

const AdvancedPanel = ({
  adv, onChange, localBase, onClose, model, models, onModel, onReloadModels, reloading,
}: {
  adv: AiAdvancedConfig;
  onChange: (patch: Partial<AiAdvancedConfig>) => void;
  localBase: boolean;
  onClose: () => void;
  model: string;
  models: string[];
  onModel: (model: string) => void;
  onReloadModels: () => void;
  reloading: boolean;
}) => (
  <div className="absolute inset-0 z-10 bg-surface/95 backdrop-blur-sm overflow-y-auto p-3.5 space-y-3">
    <div className="flex items-center justify-between">
      <span className="font-bold text-sm flex items-center gap-1.5">
        <SlidersHorizontal size={15} className="text-accent" /> Advanced
      </span>
      <button onClick={onClose} className="p-1 rounded-full hover:bg-app-text/10 opacity-70 hover:opacity-100">
        <X size={15} />
      </button>
    </div>

    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">Stream tokens</span>
      <input
        type="checkbox" checked={adv.streaming}
        onChange={(e) => onChange({ streaming: e.target.checked })}
        className="accent-[var(--app-accent)] w-4 h-4"
      />
    </label>

    {/* The model, beside the samplers.
      *
      * Changing which model answers is the same KIND of decision as changing
      * the temperature — it is the thing you fiddle with while working, not
      * part of setting the app up. It used to live only on the connect screen,
      * which you never see again once you are connected, so switching models
      * meant disconnecting first. */}
    <div className="space-y-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted font-bold">Model</span>
      {models.length > 0 ? (
        <select
          value={model}
          onChange={(e) => onModel(e.target.value)}
          data-testid="advanced-model-select"
          className="w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-xs outline-none"
        >
          {/* A model typed by hand may not be in the list. Kept as an option so
            * opening this panel cannot silently switch the reader's model to
            * whatever happens to be first. */}
          {!models.includes(model) && model && (
            <option value={model} className="text-black bg-white">{model}</option>
          )}
          {models.map(m => (
            <option key={m} value={m} className="text-black bg-white">{m}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          placeholder="gpt-4o-mini, llama-3.1-8b…"
          className="w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
        />
      )}
      <button
        onClick={onReloadModels}
        disabled={reloading}
        className="w-full flex items-center justify-center gap-1.5 py-1 rounded-md text-[11px] text-muted hover:text-app-text disabled:opacity-50"
      >
        {reloading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        {reloading ? 'Loading…' : 'Reload the model list'}
      </button>
    </div>

    <div className="space-y-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted font-bold">Samplers</span>
      <NumField label="Temperature" value={adv.temperature} onChange={(v) => onChange({ temperature: v })} min={0} max={2} />
      <NumField label="Top P" value={adv.topP} onChange={(v) => onChange({ topP: v })} min={0} max={1} />
      <NumField label="Frequency penalty" value={adv.frequencyPenalty} onChange={(v) => onChange({ frequencyPenalty: v })} min={-2} max={2} />
      <NumField label="Presence penalty" value={adv.presencePenalty} onChange={(v) => onChange({ presencePenalty: v })} min={-2} max={2} />
    </div>

    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">Extended samplers <span className="opacity-60">(local backends)</span></span>
      <input
        type="checkbox" checked={adv.extendedSamplers}
        onChange={(e) => onChange({ extendedSamplers: e.target.checked })}
        className="accent-[var(--app-accent)] w-4 h-4"
      />
    </label>
    {adv.extendedSamplers && (
      <div className="space-y-1.5 pl-2 border-l-2 border-app-border">
        {!localBase && (
          <p className="text-[10px] text-amber-500">
            Endpoint doesn't look local — top_k / min_p / repetition_penalty may be rejected by hosted APIs.
          </p>
        )}
        <NumField label="Top K" value={adv.topK} onChange={(v) => onChange({ topK: v })} step={1} min={0} />
        <NumField label="Min P" value={adv.minP} onChange={(v) => onChange({ minP: v })} min={0} max={1} />
        <NumField label="Repetition penalty" value={adv.repetitionPenalty} onChange={(v) => onChange({ repetitionPenalty: v })} min={0} />
      </div>
    )}

    <div className="space-y-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted font-bold">Budget</span>
      <NumField label="Max output tokens" value={adv.maxTokens || null} onChange={(v) => onChange({ maxTokens: v ?? 0 })} step={64} min={0} />
      <NumField label="Context size (tokens)" value={adv.contextSize || null} onChange={(v) => onChange({ contextSize: v ?? 0 })} step={512} min={0} placeholder="auto" />
    </div>

    <label className="block text-xs space-y-1">
      <span className="text-muted">System prompt <span className="opacity-60">(prepended)</span></span>
      <textarea
        rows={3} value={adv.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder="Extra persona / behavior instructions…"
        className="w-full resize-y bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50"
      />
    </label>
    <label className="block text-xs space-y-1">
      <span className="text-muted">Context template <span className="opacity-60">{'(use {{content}}, optional {{system}})'}</span></span>
      <textarea
        rows={3} value={adv.contextTemplate}
        onChange={(e) => onChange({ contextTemplate: e.target.value })}
        placeholder="Leave blank to use the built-in structure."
        className="w-full resize-y bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50 font-mono text-[11px]"
      />
    </label>

    <button onClick={onClose} className="w-full py-1.5 rounded-md bg-accent text-white text-xs font-bold">Done</button>
  </div>
);

export const AIChat = ({ embedded = false }: {
  /**
   * Render as a plain block filling its parent, with no window of its own.
   *
   * The Workspace gives the assistant a column, and a column already has a
   * position, a size and a frame — so the fixed placement, the dock gestures,
   * the lock and the resize grips are all somebody else's job there. Same
   * component and the same conversation either way; only the chrome differs.
   */
  embedded?: boolean;
} = {}) => {
  // Subscribe ONLY to the fields/actions the panel uses. A bare useAppStore()
  // re-renders on every store write — including streamedText, which ticks dozens
  // of times a second while the reader streams behind an open panel, re-running
  // ReactMarkdown for every saved turn. useShallow keeps us off that hot path.
  const store = useAppStore(useShallow(s => ({
    currentStory: s.currentStory,
    chains: s.chains,
    aiContextOpen: s.aiContextOpen,
    setAiContextOpen: s.setAiContextOpen,
    aiDockLocked: s.aiDockLocked,
    setAiDockLocked: s.setAiDockLocked,
    currentChainIndex: s.currentChainIndex,
    currentMessageIndex: s.currentMessageIndex,
    aiBaseUrl: s.aiBaseUrl,
    aiApiKey: s.aiApiKey,
    aiModel: s.aiModel,
    aiAdvanced: s.aiAdvanced,
    aiAgentMode: s.aiAgentMode,
    aiTourGuide: s.aiTourGuide,
    aiDock: s.aiDock,
    lensEditTarget: s.lensEditTarget,
    lensEditFocus: s.lensEditFocus,
    // Actions are stable references, so including them never triggers a re-render.
    setAiModel: s.setAiModel,
    setAiBaseUrl: s.setAiBaseUrl,
    setAiApiKey: s.setAiApiKey,
    setAiAdvanced: s.setAiAdvanced,
    setAiAgentMode: s.setAiAgentMode,
    setAiDock: s.setAiDock,
    setAiOpen: s.setAiOpen,
    restreamFromId: s.restreamFromId,
    setLensEditTarget: s.setLensEditTarget,
    setLensEditFocus: s.setLensEditFocus,
  })));
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [resolvedBase, setResolvedBase] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; title: string; fixes: string[]; raw?: string } | null
  >(null);
  const [probing, setProbing] = useState(false);
  const [scope, setScope] = useState<Scope>('here');
  const [includeHighlights, setIncludeHighlights] = useState(true);
  const [focusCharacter, setFocusCharacter] = useState('');
  const [activeZoneId, setActiveZoneId] = useState<string>('');
  const [visitorsOpen, setVisitorsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cowriteOpen, setCowriteOpen] = useState(false);
  const [summarizeOpen, setSummarizeOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Live streaming state for the in-flight assistant reply.
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const hasHighlights = (store.currentStory?.highlights?.length ?? 0) > 0;

  const adv = store.aiAdvanced;

  // Subscribe to the pins/sheets so the context-size readout (and the prompt)
  // update the moment a pin is toggled into context — buildContext reads these
  // via getState(), which isn't reactive on its own.
  const storyId = store.currentStory?.id;
  const pins = useAuraV2Store(s => (storyId ? s.pinsByStory[storyId] : undefined));
  const sheets = useAuraV2Store(s => (storyId ? s.sheetsByStory[storyId] : undefined));
  const inContextPins = (pins ?? []).filter(p => p.inContext).length;

  // Context Zones live in the v2 store, keyed per story.
  const zones = useAuraV2Store(s => (storyId ? s.zonesByStory[storyId] : undefined));
  const zoneBuilderOpen = useAuraV2Store(s => s.zoneBuilderOpen);
  const openZoneBuilder = useAuraV2Store(s => s.openZoneBuilder);
  const zoneList = zones ?? [];
  const activeZone = zoneList.find(z => z.id === activeZoneId);
  const visitorList = useAuraV2Store(s => (storyId ? s.visitorsByStory[storyId] : undefined));
  const activeVisitors = (visitorList ?? []).filter(v => v.active).length;

  // Keep a valid zone selected: default to the first, and recover if the
  // active one is deleted out from under us.
  useEffect(() => {
    if (scope !== 'zones') return;
    if (!activeZone && zoneList.length) setActiveZoneId(zoneList[0].id);
  }, [scope, activeZone, zoneList]);

  // Conversation threads (persisted per story) — the assistant's branch system.
  const threads = useAuraV2Store(s => (storyId ? s.chatThreadsByStory[storyId] : undefined)) ?? [];
  const activeThreadId = useAuraV2Store(s => (storyId ? s.activeThreadByStory[storyId] : undefined));
  const ensureActiveThread = useAuraV2Store(s => s.ensureActiveThread);
  const createThread = useAuraV2Store(s => s.createThread);
  const renameThread = useAuraV2Store(s => s.renameThread);
  const removeThread = useAuraV2Store(s => s.removeThread);
  const setActiveThread = useAuraV2Store(s => s.setActiveThread);
  const addTurn = useAuraV2Store(s => s.addTurn);
  const appendVariant = useAuraV2Store(s => s.appendVariant);
  const setActiveVariant = useAuraV2Store(s => s.setActiveVariant);
  const editTurn = useAuraV2Store(s => s.editTurn);
  const removeTurn = useAuraV2Store(s => s.removeTurn);
  const removeTurnsFrom = useAuraV2Store(s => s.removeTurnsFrom);
  const setOverride = useAuraV2Store(s => s.setOverride);

  const activeThread = threads.find(t => t.id === activeThreadId) ?? threads[threads.length - 1];
  const turns = activeThread?.turns ?? [];

  // Lens Edit: draft an AI rewrite of a chosen message into the Lens override layer.
  const [lensMode, setLensMode] = useState(false);
  /**
   * Rewrites waiting on the reader.
   *
   * Component state, never persisted. An unapproved edit that survives a reload
   * is an edit nobody remembers agreeing to — and the applied ones are already
   * recorded where they belong, as Lens overrides in the manager.
   */
  const [proposals, setProposals] = useState<LensProposal[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [lensModalOpen, setLensModalOpen] = useState(false);
  /** The tool this next message is for, if the reader picked one. Spent on send. */
  const [armed, setArmed] = useState<ArmedTool | null>(null);
  const pendingCount = useMemo(() => pendingProposals(proposals).length, [proposals]);

  /**
   * Where `lens.propose` puts things. Held in a ref so the closure the tool
   * context captures at send time still points at the live setter after a
   * re-render — a stale one would drop every proposal after the first.
   */
  const stageProposal = useRef((p: LensProposal) => {
    setProposals(prev => trimProposals(queueProposal(prev, p)));
    setReviewOpen(true);
  });

  /**
   * Moving and resizing the panel — desktop only.
   *
   * A phone has no room to move a window around 390px of screen, and a drag
   * there is a scroll gesture that has gone wrong. It keeps the fixed corner.
   */
  const isTouchOnly = useIsMobile();
  const dockable = !isTouchOnly && !embedded;
  const dock = usePanelDock(store.aiDock, store.setAiDock, store.aiDockLocked);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layoutOpen) return;
    const handler = (e: MouseEvent) => {
      if (layoutRef.current && !layoutRef.current.contains(e.target as Node)) setLayoutOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [layoutOpen]);
  const [spineOpen, setSpineOpen] = useState(false);
  /** How many earlier stories travel into this one — the button's count. */
  const throughlines = useAuraV2Store(s => s.throughlines);
  const spineArcs = useMemo(() => {
    const t = throughlineFor(throughlines, storyId);
    return t && storyId ? arcsBefore(t, storyId).length : 0;
  }, [throughlines, storyId]);
  const [lensTargetId, setLensTargetId] = useState<string>('');
  // flatWithIndex allocates an object per message across the whole story — a real
  // cost on mount for long stories. Only Lens needs it, so build it lazily: when
  // Lens mode is active, a Lens edit is pending, or the thread already holds a
  // Lens turn (so regenerate/swipe on it can still resolve the target).
  const needFlat = lensMode || !!store.lensEditTarget || turns.some(t => t.lensTargetId);
  const flat = useMemo(
    () => (needFlat ? flatWithIndex(store.chains) : NO_FLAT),
    [needFlat, store.chains],
  );
  const lensTarget = flat.find(f => f.msg.id === lensTargetId);

  const enterLens = () => {
    setLensMode(true);
    if (!flat.some(f => f.msg.id === lensTargetId)) {
      const cur = store.chains[store.currentChainIndex]?.messages[store.currentMessageIndex]?.id;
      setLensTargetId(cur ?? flat[0]?.msg.id ?? '');
    }
  };
  const moveTarget = (delta: 1 | -1) => {
    const i = lensTarget ? lensTarget.index - 1 : 0;
    const next = flat[Math.min(flat.length - 1, Math.max(0, i + delta))];
    if (next) setLensTargetId(next.msg.id);
  };

  // A message's "Lens edit" button opens the panel and jumps straight into edit mode.
  useEffect(() => {
    if (!store.lensEditTarget) return;
    setLensMode(true);
    setLensTargetId(store.lensEditTarget);
    store.setLensEditTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.lensEditTarget]);

  // Restore a previously-active thread on open without creating empty ones.
  useEffect(() => {
    if (!storyId) return;
    const st = useAuraV2Store.getState();
    const list = st.chatThreadsByStory[storyId] ?? [];
    if (list.length && !list.some(t => t.id === st.activeThreadByStory[storyId])) {
      st.setActiveThread(storyId, list[0].id);
    }
  }, [storyId]);

  // How many alternate versions the reader's current message has — gates the
  // "Branchline" scope, which only makes sense with more than one swipe.
  const swipeCount =
    store.chains[store.currentChainIndex]?.messages[store.currentMessageIndex]?.swipes?.length ?? 1;

  // If the reader navigates onto a single-version message while Branchline is
  // selected, fall back so we don't send an empty comparison.
  useEffect(() => {
    if (scope === 'swipes' && swipeCount < 2) setScope('here');
  }, [scope, swipeCount]);

  // Approximate size of the context that will be sent, for transparency. Uses a
  // cheap length estimate (not the full prompt build) so it never blocks the UI.
  // focusCharacter is excluded — it only adds a short line, negligible here.
  const contextChars = useMemo(
    () => estimateContextChars({ scope, includeHighlights, focusCharacter, zoneId: activeZoneId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, includeHighlights, activeZoneId, zones, store.currentChainIndex,
     store.currentMessageIndex, store.currentStory?.id, store.currentStory?.highlights,
     pins, sheets, adv],
  );
  const approxTokens = Math.round(contextChars / 4);
  const sizeLabel = approxTokens >= 1000 ? `~${(approxTokens / 1000).toFixed(1)}k tok` : `~${approxTokens} tok`;

  const configured = !!store.aiBaseUrl && !!store.aiModel;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, streamText, streaming]);

  const loadModels = async () => {
    setProbing(true); setError(null);
    try {
      const { models: m, base } = await listModels(store.aiBaseUrl, store.aiApiKey);
      setModels(m);
      setResolvedBase(base);
      if (!store.aiModel && m.length) store.setAiModel(m[0]);
    } catch (e: any) {
      setError(e?.message ?? 'Could not reach the endpoint.');
    } finally {
      setProbing(false);
    }
  };


  /**
   * Prove the endpoint actually answers, rather than merely listing itself.
   *
   * Separate from "Connect & load models" on purpose: those do different jobs
   * and fail for different reasons. Listing hits `/models`, which plenty of
   * working servers do not implement — KoboldCpp being the obvious one — so a
   * reader whose setup is perfectly fine can be told it is broken. This sends a
   * real one-token completion to the model that is actually selected, which is
   * the only thing that proves the pairing works.
   *
   * It is also the only path that can catch a base URL that lists models from
   * one place and completes at another, which some proxies do.
   */
  const testConnection = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    const started = Date.now();
    try {
      const base = resolvedBase || candidateBases(store.aiBaseUrl)[0];
      const reply = await chatCompletion(
        base, store.aiApiKey, store.aiModel,
        [{ role: 'user', content: 'Reply with the single word: ready' }],
        { max_tokens: 12, temperature: 0 },
        undefined, 'Testing connection',
      );
      setTestResult({
        ok: true,
        title: describeSuccess(store.aiModel, reply, Date.now() - started),
        fixes: [],
      });
    } catch (e) {
      const d = diagnose(e, store.aiBaseUrl, store.aiModel);
      setTestResult({ ok: false, title: d.title, fixes: d.fixes, raw: d.raw });
    } finally {
      setTesting(false);
    }
  };

  /**
   * Run one assistant generation on a thread. When `regenTurnId` is set the
   * reply is appended as a new swipe on that turn (history excludes it);
   * otherwise a fresh assistant turn is committed at the end.
   */
  const runAssistant = async (threadId: string, regenTurnId: string | null, arm?: ArmedTool | null) => {
    if (!storyId) return;
    setError(null);
    setStreaming(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    const scopeLabel = SCOPES.find(x => x.value === scope)?.label;
    try {
      const base = resolvedBase || candidateBases(store.aiBaseUrl)[0];
      const system = buildContext({ scope, includeHighlights, focusCharacter, zoneId: activeZoneId });

      // Build history from the freshly-committed thread state.
      const thread = useAuraV2Store.getState().chatThreadsByStory[storyId]?.find(t => t.id === threadId);
      let hist = thread?.turns ?? [];
      if (regenTurnId) {
        const idx = hist.findIndex(t => t.id === regenTurnId);
        if (idx >= 0) hist = hist.slice(0, idx);
      }
      const apiMsgs: ChatMsg[] = [
        { role: 'system', content: system },
        ...hist.map(t => ({
          role: t.role,
          content: t.variants[t.activeVariant] ?? t.variants[0] ?? '',
        })),
      ];

      const params = samplerParamsFrom(adv);

      /**
       * Agent mode: the model may look things up and update pins before it
       * answers.
       *
       * Same endpoint, same samplers, same system prompt — plus the catalogue,
       * and a loop that reads each reply for a directive instead of showing it
       * straight to the reader. Not streamed: the reply has to be COMPLETE
       * before it can be parsed for a fence, and streaming a half-written JSON
       * block into the panel shows the reader the machinery rather than the
       * work. The step lines are the progress indicator instead.
       */
      // Arming implies tools. A reader who picked "Lens edit" from the composer
      // has asked for the thing tools do; making them find a second switch
      // first fails silently — the directive goes out, no catalogue with it,
      // and the model's fenced block lands in the panel as raw JSON.
      // The Tour Guide is a third way in: it needs the tool loop, but a reader
      // who only wants help finding a button should not have to hand over
      // agent mode to get it — see `aiTourGuide` in types.ts.
      if (store.aiAgentMode || store.aiTourGuide || arm) {
        const agentSystem = [
          system,
          renderToolCatalog(store.aiTourGuide),
          store.aiTourGuide ? GUIDE_BRIEF : '',
          arm ? armDirective(arm) : '',
        ]
          .filter(Boolean).join('\n\n');
        const steps: ChatToolStep[] = [];
        let prose = '';
        const paint = () => setStreamText([
          prose,
          steps.map(s => `\`${s.tool}\`${s.result.ok === false ? ' — failed' : ''}`).join('\n'),
        ].filter(Boolean).join('\n\n'));

        const run = await runAgentTurn({
          system: agentSystem,
          history: apiMsgs.slice(1),
          ctx: buildToolContext(storyId, p => stageProposal.current(p)),
          // The story is in the system prompt and is never compacted; this is
          // what is left for the conversation and the tool results in it.
          budgetChars: workingBudget(agentSystem.length, adv.contextSize, adv.maxTokens),
          signal: controller.signal,
          send: (messages, signal) =>
            chatCompletion(base, store.aiApiKey, store.aiModel, messages, params, signal, 'Working'),
          onText: (t) => { prose = t; paint(); },
          onStep: (s) => {
            steps.push({ tool: s.call.tool, args: s.call.args, result: s.result });
            paint();
          },
        });

        // A turn that wrote something and then went quiet must still be
        // reported — the pin already gained a version, and silence here would
        // leave the reader believing nothing happened.
        const text = run.text.trim()
          || (steps.some(s => s.result.ok !== false)
            ? 'I ran those steps but did not write a reply. The results are above.'
            : '');
        if (!text) throw new Error('The model returned an empty reply.');
        if (regenTurnId) appendVariant(storyId, threadId, regenTurnId, text);
        else {
          addTurn(storyId, threadId, {
            role: 'assistant', variants: [text], activeVariant: 0,
            scopeLabel: arm ? armScopeLabel(arm) : scopeLabel,
            ...(steps.length ? { toolSteps: steps } : {}),
          });
        }
        return;
      }

      let full: string;
      if (adv.streaming) {
        full = await chatCompletionStream(
          base, store.aiApiKey, store.aiModel, apiMsgs, params,
          (_delta, whole) => setStreamText(whole), controller.signal,
        );
      } else {
        full = await chatCompletion(base, store.aiApiKey, store.aiModel, apiMsgs, params, controller.signal);
        setStreamText(full);
      }
      full = full.trim();
      if (!full) throw new Error('The model returned an empty reply.');
      if (regenTurnId) appendVariant(storyId, threadId, regenTurnId, full);
      else addTurn(storyId, threadId, { role: 'assistant', variants: [full], activeVariant: 0, scopeLabel });
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Request failed.');
    } finally {
      setStreaming(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  /* ------------------------------------------------------------------ */
  /* Proposals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The ONE place a suggestion becomes an edit.
   *
   * `lens.propose` has no route to the store; the modal has none either. Every
   * path from "the assistant wrote a rewrite" to "the story reads differently"
   * runs through this function, and this function only runs under a click.
   */
  const applyProposal = (p: LensProposal) => {
    if (!storyId) return;
    const problem = proposalProblem(p);
    if (problem) { setError(problem); setProposals(prev => settleProposal(prev, p.id, 'discarded')); return; }
    setOverride(storyId, {
      messageId: p.messageId,
      kind: 'rewrite',
      content: p.after.trim(),
      source: p.source === 'user' ? 'user' : 'ai',
      note: p.instruction,
      createdAt: Date.now(),
    });
    setProposals(prev => trimProposals(settleProposal(prev, p.id, 'applied')));
    void flushV2();
    store.restreamFromId(p.messageId);
  };

  const discardProposal = (p: LensProposal) =>
    setProposals(prev => trimProposals(settleProposal(prev, p.id, 'discarded')));

  /**
   * Apply every waiting rewrite.
   *
   * Reading order, and each one resolved against the store as it is at that
   * moment rather than against a snapshot — two proposals for the same message
   * cannot both be pending (`queueProposal` sees to that), so the ordering only
   * has to be stable, not clever.
   */
  const applyAllProposals = () => {
    pendingProposals(proposals).forEach(applyProposal);
  };

  /**
   * Rewrite the picked passages directly, with no conversation.
   *
   * Same request `runLens` builds, run once per pick, except that the result is
   * staged instead of applied. The reader still approves every one; skipping the
   * chat skips the discussion, not the review.
   */
  const runLensPicks = async (picks: LensPick[], instruction: string) => {
    if (!storyId || !picks.length || !instruction.trim()) return;
    setLensModalOpen(false);
    setError(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let failed = 0;
    try {
      const base = resolvedBase || candidateBases(store.aiBaseUrl)[0];
      const card = cardToPromptBlock(store.currentStory?.card);
      const params = samplerParamsFrom(adv);
      for (const pick of picks) {
        if (controller.signal.aborted) break;
        setStreamText(`Rewriting #${pick.index}…`);
        const system = [
          `You are revising a single passage from the story "${store.currentStory?.title ?? 'Untitled'}" for the reader's private "Lens" layer.`,
          'Rewrite the PASSAGE according to the INSTRUCTION. Keep the speaker\'s voice and the meaning intact unless the instruction says otherwise.',
          'Output ONLY the rewritten passage — no preamble, no surrounding quotes, no commentary.',
          card ? `\n${card}` : '',
        ].filter(Boolean).join('\n');
        const full = (await chatCompletion(
          base, store.aiApiKey, store.aiModel,
          [
            { role: 'system', content: system },
            { role: 'user', content: `INSTRUCTION: ${instruction}\n\nPASSAGE (speaker: ${pick.name}):\n${pick.content}` },
          ],
          params, controller.signal,
        )).trim();
        if (!full) { failed++; continue; }
        const proposal = makeProposal({
          messageId: pick.messageId,
          index: pick.index,
          name: pick.name,
          before: pick.content,
          after: full,
          kind: 'revision',
          instruction,
          source: 'user',
        });
        // An echo is not a rewrite. Staging one would badge the message as
        // edited with nothing for the reader to see.
        if (proposalProblem(proposal)) { failed++; continue; }
        stageProposal.current(proposal);
      }
      if (failed) {
        setError(failed === picks.length
          ? 'None of those came back as a real change. Try a more specific instruction.'
          : `${failed} of ${picks.length} came back unchanged and were skipped.`);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Request failed.');
    } finally {
      setStreaming(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  /** Write a rewrite into the Lens layer (auto-enables lens) and replay it in the reader. */
  const applyLens = (messageId: string, text: string, instruction?: string) => {
    if (!storyId || !text.trim()) return;
    setOverride(storyId, {
      messageId, kind: 'rewrite', content: text.trim(), source: 'ai',
      note: instruction, createdAt: Date.now(),
    });
    // Jump the reader to the message and restream it with the new Lens content.
    store.restreamFromId(messageId);
  };

  /**
   * Generate a Lens rewrite of a single message. Streams the draft into the chat
   * thread, commits it as a lens turn (its variants are drafts), and applies it.
   */
  const runLens = async (threadId: string, regenTurnId: string | null, targetId: string, instruction: string) => {
    if (!storyId) return;
    const entry = flat.find(f => f.msg.id === targetId);
    if (!entry) { setError('Pick a message to edit.'); return; }
    const v2 = useAuraV2Store.getState();
    // Rewrite whatever is currently shown, so successive edits build on each other.
    const current = resolveContent(entry.msg, v2.overridesByStory[storyId], !!v2.lensOnByStory[storyId]);
    // Passage structure — dialogue/thought/beat/shout, each attributed to a
    // speaker — supplements the raw passage so the rewrite is less likely to
    // conflate who said or thought what, especially on a multi-voice passage.
    const cast = castOf(flat.map(f => f.msg), store.currentStory?.userName);
    const structure = renderNarrativeBlocks(narrativeBlocksFor(
      current, entry.msg.name, { cast, dialogue: v2.sceneByStory[storyId]?.[targetId]?.dialogue },
    ));

    setError(null);
    setStreaming(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const base = resolvedBase || candidateBases(store.aiBaseUrl)[0];
      const card = cardToPromptBlock(store.currentStory?.card);
      const system = [
        `You are revising a single passage from the story "${store.currentStory?.title ?? 'Untitled'}" for the reader's private "Lens" layer.`,
        'Rewrite the PASSAGE according to the INSTRUCTION. Keep the speaker\'s voice and the meaning intact unless the instruction says otherwise.',
        'Output ONLY the rewritten passage — no preamble, no surrounding quotes, no commentary.',
        card ? `\n${card}` : '',
      ].filter(Boolean).join('\n');
      const apiMsgs: ChatMsg[] = [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `INSTRUCTION: ${instruction}\n\nPASSAGE (speaker: ${entry.msg.name}):\n${current}`
            + (structure ? `\n\nPASSAGE STRUCTURE:\n${structure}` : ''),
        },
      ];
      const params = samplerParamsFrom(adv);
      let full: string;
      if (adv.streaming) {
        full = await chatCompletionStream(
          base, store.aiApiKey, store.aiModel, apiMsgs, params,
          (_d, whole) => setStreamText(whole), controller.signal,
        );
      } else {
        full = await chatCompletion(base, store.aiApiKey, store.aiModel, apiMsgs, params, controller.signal);
        setStreamText(full);
      }
      full = full.trim();
      if (!full) throw new Error('The model returned an empty rewrite.');
      if (regenTurnId) appendVariant(storyId, threadId, regenTurnId, full);
      else addTurn(storyId, threadId, {
        role: 'assistant', variants: [full], activeVariant: 0,
        scopeLabel: `Lens → #${entry.index}`, lensTargetId: targetId, lensInstruction: instruction,
      });
      applyLens(targetId, full, instruction);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Request failed.');
    } finally {
      setStreaming(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  /**
   * Run a cowriting preset. The payload is assembled by buildCowritePayload
   * (reference in the system block, candidate branches + instruction in the
   * final user turn) and sent as a self-contained [system, user] pair — no
   * prior thread history, so placement isn't diluted. The resolved spec is
   * stored on the turn so regenerate rebuilds the identical request.
   */
  const runCowrite = async (threadId: string, regenTurnId: string | null, spec: CowriteRunSpec) => {
    if (!storyId) return;
    setError(null);
    setStreaming(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const base = resolvedBase || candidateBases(store.aiBaseUrl)[0];
      const v2 = useAuraV2Store.getState();
      const resolve = (m: Message) => resolveContent(m, v2.overridesByStory[storyId], !!v2.lensOnByStory[storyId]);
      const { system, userMessage, empty } =
        buildCowritePayload(spec, store.chains, resolve, store.currentStory ?? undefined);
      if (empty) throw new Error('No candidate versions to send.');
      const apiMsgs: ChatMsg[] = [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ];
      const params = samplerParamsFrom(adv);
      let full: string;
      if (adv.streaming) {
        full = await chatCompletionStream(
          base, store.aiApiKey, store.aiModel, apiMsgs, params,
          (_d, whole) => setStreamText(whole), controller.signal,
        );
      } else {
        full = await chatCompletion(base, store.aiApiKey, store.aiModel, apiMsgs, params, controller.signal);
        setStreamText(full);
      }
      full = full.trim();
      if (!full) throw new Error('The model returned an empty reply.');
      if (regenTurnId) appendVariant(storyId, threadId, regenTurnId, full);
      else addTurn(storyId, threadId, {
        role: 'assistant', variants: [full], activeVariant: 0,
        scopeLabel: `Cowrite → ${spec.presetName}`, cowriteSpec: spec,
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Request failed.');
    } finally {
      setStreaming(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  /**
   * Write one turn AS a visiting character.
   *
   * The counterpart to interviewing them in Ask Character: there they answer a
   * question about a beat, here they act in one. Same boundary in both — the
   * turn lands in the reader's chat as a DRAFT and nothing writes it into the
   * story. A character on loan from another chat is the last thing that should
   * get to edit this one.
   *
   * What they are shown is the scene the reader's own context scope selected,
   * and the prompt says which scope that was, so a visitor shown one page does
   * not talk as though they had read the book.
   */
  const runVisitorTurn = async (
    threadId: string, regenTurnId: string | null, spec: VisitorTurnSpec,
  ) => {
    if (!storyId) return;
    const v2 = useAuraV2Store.getState();
    const visitor = (v2.visitorsByStory[storyId] ?? []).find(v => v.id === spec.visitorId);
    if (!visitor) { setError(`${spec.name} is no longer in this story.`); return; }
    setError(null);
    setStreaming(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const scene = collectTranscript(scope === 'zones' || scope === 'swipes' ? 'here' : scope);
      // Their own card, when the reader has left it switched on: the brief is
      // what they KNOW, the card is how they SOUND, and a brief alone writes a
      // character who is factually right and generically voiced.
      const card: Card | undefined = visitor.useCard === false
        ? undefined
        : (await getStory(visitor.sourceStoryId))?.card;
      const full = (await askText(
        { base: resolvedBase || candidateBases(store.aiBaseUrl)[0], key: store.aiApiKey, model: store.aiModel },
        buildVisitorTurnMessages({
          visitor,
          card,
          hostTitle: store.currentStory?.title ?? 'this story',
          hostCharacter: store.currentStory?.characterName,
          hostUser: store.currentStory?.userName,
          scene,
          sceneLabel: SCOPES.find(sc => sc.value === scope)?.label,
          instruction: spec.instruction,
        }),
        {
          label: `${visitor.name} is writing`,
          reader: samplerParamsFrom(adv),
          signal: controller.signal,
        },
      )).trim();
      if (!full) throw new Error('The model returned an empty turn.');
      if (regenTurnId) appendVariant(storyId, threadId, regenTurnId, full);
      else addTurn(storyId, threadId, {
        role: 'assistant', variants: [full], activeVariant: 0,
        scopeLabel: `⁘ ${visitor.name} speaks`, visitorSpec: { ...spec, name: visitor.name },
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? 'Request failed.');
    } finally {
      setStreaming(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  const startVisitorTurn = (visitorId: string, name: string, instruction?: string) => {
    if (!storyId || streaming) return;
    const threadId = ensureActiveThread(storyId);
    addTurn(storyId, threadId, {
      role: 'user', variants: [`⁘ ${name}, take a turn${instruction ? `: ${instruction}` : ''}`], activeVariant: 0,
    });
    // Get out of the way, as Cowrite does when it runs. The drawer is a tall
    // panel directly above the conversation, and leaving it open pushes the
    // turn the reader just asked for below the fold of its own thread.
    setVisitorsOpen(false);
    void runVisitorTurn(threadId, null, { visitorId, name, instruction });
  };

  const startCowrite = (spec: CowriteRunSpec) => {
    if (!storyId || streaming) return;
    const threadId = ensureActiveThread(storyId);
    const n = spec.candidates.length;
    const summary = `⨺ ${spec.presetName}: ${n} branch${n === 1 ? '' : 'es'}${spec.referenceIds.length ? ` · ref ${spec.referenceIds.length}` : ''}`;
    addTurn(storyId, threadId, { role: 'user', variants: [summary], activeVariant: 0 });
    setCowriteOpen(false);
    void runCowrite(threadId, null, spec);
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || streaming || !storyId) return;
    const threadId = ensureActiveThread(storyId);

    if (lensMode) {
      if (!lensTarget) { setError('Pick a message to edit.'); return; }
      /* A framed span becomes part of the INSTRUCTION, not a separate field:
       * the Lens already sends the whole passage as the thing being revised,
       * so what the focus adds is "this part of it", in the reader's own
       * words. Quoted with a delimiter the prose cannot contain. */
      const focus = store.lensEditFocus?.trim();
      const instruction = focus
        ? `${content}\n\nApply this to the following part of the passage, and leave the rest as written:\n<<<\n${focus}\n>>>`
        : content;
      addTurn(storyId, threadId, {
        role: 'user',
        variants: [`✎ Lens edit #${lensTarget.index}: ${content}${focus ? ' — on the framed span' : ''}`],
        activeVariant: 0,
      });
      setInput('');
      store.setLensEditFocus(null);
      await runLens(threadId, null, lensTarget.msg.id, instruction);
      return;
    }

    /**
     * The arm is SPENT here, before the request goes out.
     *
     * An arm that survived its turn would silently make the next ordinary
     * question another rewrite — the exact failure arming exists to prevent,
     * only harder to notice because nothing on screen would have changed.
     */
    const arm = armed;
    setArmed(null);
    addTurn(storyId, threadId, {
      role: 'user',
      variants: [arm ? `${armLabel(arm)} — ${content}` : content],
      activeVariant: 0,
    });
    setInput('');
    await runAssistant(threadId, null, arm);
  };

  /**
   * Keep a reply beside the story.
   *
   * A first line that reads like a title becomes the title, because a dock full
   * of pins called "Assistant reply" is a dock you cannot read. Markdown
   * format: the assistant answers in markdown and the pin renderer already
   * speaks it.
   */
  const pinTurn = useCallback((text: string) => {
    const sid = useAppStore.getState().currentStory?.id;
    if (!sid || !text.trim()) return;
    const first = text.trim().split('\n').find(l => l.trim()) ?? '';
    const title = first.replace(/^#{1,6}\s*/, '').replace(/[*_`]/g, '').trim().slice(0, 60)
      || 'Assistant reply';
    useAuraV2Store.getState().addPin(sid, {
      title,
      format: 'markdown',
      content: text,
      inContext: false,
      docked: true,
    });
  }, []);

  const regenerate = () => {
    if (streaming || !storyId || !activeThread) return;
    const last = turns[turns.length - 1];
    if (last?.role !== 'assistant') return;
    if (last.visitorSpec) void runVisitorTurn(activeThread.id, last.id, last.visitorSpec);
    else if (last.cowriteSpec) void runCowrite(activeThread.id, last.id, last.cowriteSpec);
    else if (last.lensTargetId) void runLens(activeThread.id, last.id, last.lensTargetId, last.lensInstruction ?? '');
    else void runAssistant(activeThread.id, last.id);
  };

  const stop = () => abortRef.current?.abort();

  const editTurnText = (turnId: string, text: string) => {
    if (!storyId || !activeThread) return;
    editTurn(storyId, activeThread.id, turnId, text);
    // A Lens draft edited by hand must reach the page, or the reader has
    // corrected a rewrite and the story still shows the model's version.
    const turn = turns.find(t => t.id === turnId);
    if (turn?.lensTargetId) applyLens(turn.lensTargetId, text, turn.lensInstruction);
  };

  const deleteTurn = (turnId: string) => {
    if (streaming || !storyId || !activeThread) return;
    removeTurn(storyId, activeThread.id, turnId);
  };

  /**
   * Generate again from a turn part-way up the thread.
   *
   * Everything below it goes first — a reply cannot be re-answered while the
   * exchange that followed it is still there, and silently keeping those turns
   * would leave the thread contradicting itself. An assistant turn regenerates
   * in place as a new swipe, so the version being replaced is still reachable;
   * a user turn gets a fresh reply after it.
   */
  const retryFrom = (turn: ChatTurn) => {
    if (streaming || !storyId || !activeThread) return;
    const list = useAuraV2Store.getState().chatThreadsByStory[storyId]
      ?.find(t => t.id === activeThread.id)?.turns ?? [];
    const idx = list.findIndex(t => t.id === turn.id);
    if (idx === -1) return;
    const next = list[idx + 1];
    if (turn.role === 'assistant') {
      if (next) removeTurnsFrom(storyId, activeThread.id, next.id);
      if (turn.visitorSpec) void runVisitorTurn(activeThread.id, turn.id, turn.visitorSpec);
      else if (turn.cowriteSpec) void runCowrite(activeThread.id, turn.id, turn.cowriteSpec);
      else if (turn.lensTargetId) void runLens(activeThread.id, turn.id, turn.lensTargetId, turn.lensInstruction ?? '');
      else void runAssistant(activeThread.id, turn.id);
    } else {
      if (next) removeTurnsFrom(storyId, activeThread.id, next.id);
      void runAssistant(activeThread.id, null);
    }
  };

  const swipeTurn = (turn: ChatTurn, dir: -1 | 1) => {
    if (!storyId || !activeThread) return;
    const idx = turn.activeVariant + dir;
    setActiveVariant(storyId, activeThread.id, turn.id, idx);
    // Switching between drafts of a Lens edit re-applies the shown one to the reader.
    if (turn.lensTargetId && turn.variants[idx]) applyLens(turn.lensTargetId, turn.variants[idx], turn.lensInstruction);
  };

  const startRename = () => {
    if (!activeThread) return;
    setRenameValue(activeThread.name);
    setRenaming(true);
  };
  const commitRename = () => {
    if (storyId && activeThread && renameValue.trim()) renameThread(storyId, activeThread.id, renameValue);
    setRenaming(false);
  };
  const newThread = () => {
    if (!storyId) return;
    createThread(storyId);
    setRenaming(false);
  };
  const deleteThread = () => {
    if (storyId && activeThread) removeThread(storyId, activeThread.id);
    setRenaming(false);
  };

  return (
    <>
    {/* Positioned by `usePanelDock`, not by Tailwind. A phone keeps the old
      * fixed corner — there is no room to move a panel around a 390px screen,
      * and a drag there is a scroll gesture that has gone wrong. */}
    <div
      className={cn(
        'flex flex-col overflow-hidden bg-surface',
        embedded
          ? 'h-full w-full'
          : cn(
            'fixed z-[65] rounded-2xl border border-app-border shadow-2xl',
            dockable ? '' : 'bottom-4 right-4 w-[min(420px,92vw)] h-[min(620px,80vh)]',
          ),
        dock.active && 'select-none',
      )}
      style={dockable ? dockStyle(dock.rect) : undefined}
      data-testid="ai-panel"
    >
      {/* The header is the drag handle. `touch-none` stops the browser turning
        * a slow drag into a page scroll on a trackpad or a pen. */}
      <div
        onPointerDown={dockable ? dock.onDragStart : undefined}
        className={cn(
          'flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-text/5',
          dockable && 'touch-none',
          dockable && !store.aiDockLocked && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <div className="flex items-center gap-2 font-bold text-sm">
          {dockable && (
            <GripVertical
              size={14}
              className={cn('shrink-0', store.aiDockLocked ? 'opacity-15' : 'opacity-40')}
            />
          )}
          <Bot size={17} className="text-accent" /> Reading Assistant
        </div>
        <div className="flex items-center gap-0.5">
          {dockable && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => store.setAiDockLocked(!store.aiDockLocked)}
              aria-pressed={store.aiDockLocked}
              title={store.aiDockLocked
                ? 'Unlock — let this panel be dragged and resized again'
                : 'Lock this panel where it is'}
              aria-label={store.aiDockLocked ? 'Unlock the panel' : 'Lock the panel'}
              data-testid="ai-lock"
              className={cn(
                'p-1.5 rounded-full hover:bg-app-text/10',
                store.aiDockLocked ? 'text-accent opacity-100' : 'opacity-60 hover:opacity-100',
              )}
            >
              {store.aiDockLocked ? <Lock size={15} /> : <LockOpen size={15} />}
            </button>
          )}
          {dockable && (
            <div className="relative" ref={layoutRef}>
              <button
                // The menu button must not start a drag as well as open.
                onPointerDown={e => e.stopPropagation()}
                onClick={() => setLayoutOpen(v => !v)}
                disabled={store.aiDockLocked}
                aria-label="Panel layout"
                title={store.aiDockLocked
                  ? 'The panel is locked — unlock it to move or resize it'
                  : 'Move and resize this panel'}
                data-testid="ai-layout"
                className="p-1.5 rounded-full opacity-60 hover:opacity-100 hover:bg-app-text/10 disabled:opacity-25 disabled:hover:bg-transparent"
              >
                <Maximize2 size={15} />
              </button>
              {layoutOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-surface border border-app-border shadow-2xl p-1 z-50">
                  {(Object.keys(PRESET_LABEL) as DockPreset[]).map(p => (
                    <button
                      key={p}
                      onClick={() => {
                        dock.setRect(presetDock(p, { width: window.innerWidth, height: window.innerHeight }));
                        setLayoutOpen(false);
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs hover:bg-app-text/5"
                    >
                      {PRESET_LABEL[p]}
                    </button>
                  ))}
                  <div className="border-t border-app-border/60 mt-1 pt-1">
                    <button
                      onClick={() => { dock.reset(); setLayoutOpen(false); }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-muted hover:bg-app-text/5"
                    >
                      Reset position
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={() => store.setAiOpen(false)}
            aria-label="Close the reading assistant"
            data-testid="ai-close"
            hidden={embedded}
            className="p-1.5 rounded-full opacity-60 hover:opacity-100 hover:bg-app-text/10"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Resize grips. Invisible until hovered — they are muscle memory, not
        * decoration, and four visible handles on a chat window is clutter.
        * Gone entirely while locked: an edge that shows a resize cursor and
        * then refuses to resize reads as broken rather than as locked. */}
      {dockable && !store.aiDockLocked && (
        <>
          {(['n', 's', 'e', 'w'] as const).map(edge => (
            <div
              key={edge}
              onPointerDown={dock.onResizeStart(edge)}
              className={cn(
                'absolute touch-none z-30',
                edge === 'n' && 'top-0 left-3 right-3 h-1.5 cursor-ns-resize',
                edge === 's' && 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize',
                edge === 'w' && 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
                edge === 'e' && 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
              )}
            />
          ))}
          {(['nw', 'ne', 'sw', 'se'] as const).map(edge => (
            <div
              key={edge}
              onPointerDown={dock.onResizeStart(edge)}
              className={cn(
                'absolute w-3.5 h-3.5 touch-none z-30',
                edge === 'nw' && 'top-0 left-0 cursor-nwse-resize',
                edge === 'ne' && 'top-0 right-0 cursor-nesw-resize',
                edge === 'sw' && 'bottom-0 left-0 cursor-nesw-resize',
                edge === 'se' && 'bottom-0 right-0 cursor-nwse-resize',
              )}
            />
          ))}
        </>
      )}

      {!configured ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
          <p className="text-muted leading-relaxed">
            Connect any <b>OpenAI-compatible</b> endpoint (OpenAI, OpenRouter, LM Studio,
            Ollama, KoboldCpp…). Paste the base URL — the <code>/v1</code> prefix and
            endpoints are figured out for you.
          </p>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">Base URL</span>
            <input
              type="text"
              placeholder="https://api.openai.com  ·  http://localhost:1234"
              value={store.aiBaseUrl}
              onChange={(e) => store.setAiBaseUrl(e.target.value)}
              className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50"
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">API key (optional)</span>
            <input
              type="password"
              placeholder="sk-…  (leave blank for local)"
              value={store.aiApiKey}
              onChange={(e) => store.setAiApiKey(e.target.value)}
              className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50"
            />
          </label>
          <button
            onClick={loadModels}
            disabled={!store.aiBaseUrl || probing}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-accent text-white font-medium disabled:opacity-50"
          >
            {probing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {probing ? 'Connecting…' : 'Connect & load models'}
          </button>
          {models.length > 0 && (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-muted">Model</span>
              <select
                value={store.aiModel}
                onChange={(e) => { store.setAiModel(e.target.value); setTestResult(null); }}
                data-testid="model-select"
                className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none"
              >
                <option value="" className="text-black bg-white">Choose a model…</option>
                {models.map(m => (
                  <option key={m} value={m} className="text-black bg-white">{m}</option>
                ))}
              </select>
            </label>
          )}
          {/* Manual entry stays available even after a list loads.
            *
            * Some servers list one set of names and accept another, and some
            * list nothing at all while working perfectly. Hiding the field the
            * moment a list arrives takes the escape hatch away from exactly the
            * people who need it. */}
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">
              {models.length > 0 ? 'Model (or type one)' : 'Model (manual)'}
            </span>
            <input
              type="text"
              placeholder="gpt-4o-mini, llama-3.1-8b…"
              value={store.aiModel}
              onChange={(e) => { store.setAiModel(e.target.value); setTestResult(null); }}
              className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 outline-none focus:border-accent/50"
            />
          </label>

          {/* The button that actually proves it works — see `testConnection`. */}
          <button
            onClick={testConnection}
            disabled={!store.aiBaseUrl || !store.aiModel || testing || probing}
            data-testid="test-connection"
            title={!store.aiModel ? 'Choose or type a model first' : 'Send one tiny request and report what happens'}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md border border-app-border font-medium disabled:opacity-50 hover:border-accent/50"
          >
            {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
            {testing ? 'Testing…' : 'Test connection'}
          </button>

          {testResult && (
            <div className={cn(
              'rounded-md border p-2.5 text-xs leading-relaxed',
              testResult.ok
                ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-400'
                : 'border-amber-500/40 bg-amber-500/5 text-app-text',
            )}>
              <p className={testResult.ok ? '' : 'text-amber-400'}>{testResult.title}</p>
              {testResult.fixes.length > 0 && (
                <ul className="mt-1.5 space-y-1 text-muted list-disc pl-4">
                  {testResult.fixes.map(f => <li key={f}>{f}</li>)}
                </ul>
              )}
              {testResult.raw && (
                <p className="mt-1.5 text-[10px] text-muted/70 font-mono break-all">
                  {testResult.raw}
                </p>
              )}
            </div>
          )}
          {error && <p className="text-red-500 text-xs">{error}</p>}
        </div>
      ) : (
        <>
          {/* Thread bar — the assistant's saved conversation branches. */}
          <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-app-border text-xs">
            {renaming ? (
              <>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
                  className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50"
                />
                <button onClick={commitRename} title="Save name" className="p-1 rounded hover:bg-app-text/10 text-accent">
                  <Check size={14} />
                </button>
              </>
            ) : (
              <>
                <select
                  value={activeThread?.id ?? ''}
                  onChange={(e) => storyId && setActiveThread(storyId, e.target.value)}
                  disabled={threads.length === 0}
                  className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 py-1 outline-none focus:border-accent/50 disabled:opacity-60"
                >
                  {threads.length === 0 ? (
                    <option value="" className="text-black bg-white">New chat</option>
                  ) : (
                    threads.map(t => (
                      <option key={t.id} value={t.id} className="text-black bg-white">
                        {t.name} ({t.turns.length})
                      </option>
                    ))
                  )}
                </select>
                <button
                  onClick={startRename}
                  disabled={!activeThread}
                  title="Rename this chat"
                  className="p-1 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 disabled:opacity-30"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={deleteThread}
                  disabled={!activeThread}
                  title="Delete this chat"
                  className="p-1 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 disabled:opacity-30"
                >
                  <Trash2 size={13} />
                </button>
                <button
                  onClick={newThread}
                  title="Start a new chat branch"
                  className="p-1 rounded hover:bg-app-text/10 text-accent"
                >
                  <Plus size={15} />
                </button>
              </>
            )}
          </div>

          {/*
            * The context block folds.
            *
            * Open by default and remembered, because WHICH passages the model
            * is about to be shown is the most consequential thing on this
            * panel — but once a reader has settled on a scope it is a header
            * eating the top fifth of a narrow column, so it can be put away.
            * The summary line keeps the size and the scope visible while
            * closed, so folding it never means losing track of what is sent.
            */}
          <div className="border-b border-app-border px-2.5 py-2 space-y-2 bg-app-text/[0.03]">
            <button
              onClick={() => store.setAiContextOpen(!store.aiContextOpen)}
              aria-expanded={store.aiContextOpen}
              data-testid="context-toggle"
              className="w-full flex items-center justify-between gap-2 -my-0.5 py-0.5 rounded hover:bg-app-text/5 transition-colors"
            >
              <span className="flex items-center gap-1 min-w-0">
                <ChevronDown
                  size={12}
                  className={cn('shrink-0 text-muted transition-transform', !store.aiContextOpen && '-rotate-90')}
                />
                <span className="text-[10px] uppercase tracking-wider text-muted font-bold">Context</span>
                {!store.aiContextOpen && (
                  <span className="text-[10px] text-muted truncate normal-case">
                    · {SCOPES.find(sc => sc.value === scope)?.label ?? scope}
                    {scope === 'zones' && activeZone ? ` · ${activeZone.name}` : ''}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1.5">
                {inContextPins > 0 && (
                  <span
                    className="text-[10px] font-bold text-accent bg-accent/10 rounded px-1.5 py-0.5"
                    title={`${inContextPins} pinned visual${inContextPins === 1 ? '' : 's'} sent in full as reference`}
                  >
                    📌 {inContextPins}
                  </span>
                )}
                <span className="text-[10px] text-muted font-mono" title={`${contextChars.toLocaleString()} characters sent to the model`}>
                  {sizeLabel}
                </span>
              </span>
            </button>
            {store.aiContextOpen && (<>
            <div className="flex items-center gap-1">
              {SCOPES.map(sc => {
                const disabled = sc.value === 'swipes' && swipeCount < 2;
                return (
                  <button
                    key={sc.value}
                    onClick={() => setScope(sc.value)}
                    disabled={disabled}
                    title={sc.value === 'swipes'
                      ? (disabled
                        ? 'This message has only one version — no swipes to compare'
                        : `Compare all ${swipeCount} versions (swipes) of the current message`)
                      : undefined}
                    className={cn(
                      'flex-1 text-[11px] py-1 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                      scope === sc.value
                        ? 'border-accent bg-accent/10 text-accent font-bold'
                        : 'border-app-border hover:bg-app-text/5',
                    )}
                  >
                    {sc.value === 'swipes' && !disabled ? `${sc.label} (${swipeCount})` : sc.label}
                  </button>
                );
              })}
            </div>
            {scope === 'zones' && (
              <div className="flex items-center gap-1.5">
                {zoneList.length > 0 ? (
                  <select
                    value={activeZoneId}
                    onChange={(e) => setActiveZoneId(e.target.value)}
                    className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 py-1 text-xs outline-none focus:border-accent/50"
                  >
                    {zoneList.map(z => (
                      <option key={z.id} value={z.id} className="text-black bg-white">
                        {z.name}{store.chains.length ? ` — ${zoneSummary(z, store.chains, store.currentStory?.timelines ?? [])}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="flex-1 text-[11px] text-muted italic">No zones yet — build one to pick messages &amp; branchlines.</span>
                )}
                {zoneList.length > 0 && (
                  <button
                    onClick={() => openZoneBuilder(activeZoneId || zoneList[0].id)}
                    title="Edit this zone"
                    className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5 whitespace-nowrap"
                  >
                    Edit
                  </button>
                )}
                <button
                  onClick={() => openZoneBuilder(null)}
                  title="Build a new context zone"
                  className="text-[11px] px-2 py-1 rounded-md border border-accent bg-accent/10 text-accent font-bold whitespace-nowrap"
                >
                  + New
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={focusCharacter}
                onChange={(e) => setFocusCharacter(e.target.value)}
                placeholder="Focus a character (optional)…"
                className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 py-1 text-xs outline-none focus:border-accent/50"
              />
              <button
                onClick={() => setIncludeHighlights(v => !v)}
                disabled={!hasHighlights}
                title={hasHighlights ? 'Include your highlights & notes as context' : 'No highlights yet'}
                className={cn(
                  'text-[11px] px-2 py-1 rounded-md border whitespace-nowrap transition-colors disabled:opacity-40',
                  includeHighlights && hasHighlights
                    ? 'border-accent bg-accent/10 text-accent font-bold'
                    : 'border-app-border hover:bg-app-text/5',
                )}
              >
                ★ Highlights
              </button>
              {/* Visitors sit with the context controls, not with the Lens: the
                * Lens rewrites messages that exist, a visitor assembles context
                * for a generation that has not happened yet. */}
              <button
                onClick={() => setVisitorsOpen(v => !v)}
                title="Bring a character in from another chat"
                data-testid="visitors-toggle"
                className={cn(
                  'text-[11px] px-2 py-1 rounded-md border whitespace-nowrap transition-colors',
                  activeVisitors > 0
                    ? 'border-accent bg-accent/10 text-accent font-bold'
                    : 'border-app-border hover:bg-app-text/5',
                )}
              >
                ⁘ Visitors{activeVisitors > 0 ? ` ${activeVisitors}` : ''}
              </button>
              {/* Beside Visitors, and deliberately: a visitor is somebody ELSE
                * arriving from another chat, and a throughline is YOU arriving
                * from one. Same machinery, opposite direction. */}
              <button
                onClick={() => setSpineOpen(v => !v)}
                title="Who you are across your chats"
                data-testid="throughline-toggle"
                className={cn(
                  'text-[11px] px-2 py-1 rounded-md border whitespace-nowrap transition-colors',
                  spineArcs > 0
                    ? 'border-accent bg-accent/10 text-accent font-bold'
                    : 'border-app-border hover:bg-app-text/5',
                )}
              >
                ⟜ Throughline{spineArcs > 0 ? ` ${spineArcs}` : ''}
              </button>
            </div>
            {visitorsOpen && (
              <div className="pt-1">
                <VisitorPanel
                  busy={streaming}
                  onSpeak={(v, instruction) => startVisitorTurn(v.id, v.name, instruction)}
                />
              </div>
            )}
            {spineOpen && (
              <div className="pt-1 max-h-[60vh] overflow-hidden rounded-lg border border-app-border">
                <ThroughlinePanel onClose={() => setSpineOpen(false)} />
              </div>
            )}
            </>)}
          </div>

          {/* ── The chat body ────────────────────────────────────────────────
            * Two boxes, deliberately. The outer one is the SIZE of the body and
            * never scrolls; the inner one scrolls inside it.
            *
            * The panels below (Advanced, Cowrite, Summarize, Tasks) are
            * `absolute inset-0`, and an absolute box inside a scroller is
            * positioned against the CONTENT, not the visible window — so with a
            * long conversation they opened somewhere far up the scrollback and
            * the button appeared to do nothing at all. Splitting the scroll off
            * gives them a fixed frame to cover, so a panel opens over what the
            * reader is looking at no matter how far down they are. */}
          <div className="flex-1 min-h-0 relative">
          <div className="absolute inset-0 overflow-y-auto p-3 space-y-3">
            {turns.length === 0 && !streaming && (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted text-center">
                  Ask about the story — context: <b>{SCOPES.find(s => s.value === scope)?.label}</b>
                  {includeHighlights && hasHighlights ? ' + your highlights' : ''}.
                </p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {(scope === 'swipes' ? BRANCHLINE_QUICK : QUICK).map(q => (
                    <button
                      key={q.label}
                      onClick={() => send(q.prompt)}
                      className="text-xs px-2.5 py-1 rounded-full border border-app-border hover:bg-app-text/5"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <TurnView
                key={t.id}
                turn={t}
                isLast={i === turns.length - 1 && !streaming}
                busy={streaming}
                onSwipe={(dir) => swipeTurn(t, dir)}
                onRegenerate={regenerate}
                onEdit={(text) => editTurnText(t.id, text)}
                onDelete={() => deleteTurn(t.id)}
                onRetry={() => retryFrom(t)}
                onPin={pinTurn}
              />
            ))}
            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl bg-app-text/5 border border-app-border rounded-bl-sm text-sm">
                  {streamText
                    ? <Markdown>{streamText}</Markdown>
                    : <Loader2 size={16} className="animate-spin opacity-60" />}
                </div>
              </div>
            )}
            {error && <p className="text-red-500 text-xs px-1">{error}</p>}
            <div ref={bottomRef} />
          </div>

            {advancedOpen && (
              <AdvancedPanel
                adv={adv}
                onChange={store.setAiAdvanced}
                localBase={isLocalBase(resolvedBase || store.aiBaseUrl)}
                onClose={() => setAdvancedOpen(false)}
                model={store.aiModel}
                models={models}
                onModel={store.setAiModel}
                onReloadModels={loadModels}
                reloading={probing}
              />
            )}

            {cowriteOpen && (
              <CowritePanel
                chains={store.chains}
                currentMessageId={store.chains[store.currentChainIndex]?.messages[store.currentMessageIndex]?.id}
                onRun={startCowrite}
                onClose={() => setCowriteOpen(false)}
              />
            )}

            {summarizeOpen && (
              <SummarizePanel
                base={resolvedBase || store.aiBaseUrl}
                apiKey={store.aiApiKey}
                model={store.aiModel}
                onClose={() => setSummarizeOpen(false)}
              />
            )}

            {tasksOpen && (
              <TaskPanel
                base={resolvedBase || store.aiBaseUrl}
                apiKey={store.aiApiKey}
                model={store.aiModel}
                onClose={() => setTasksOpen(false)}
              />
            )}

            {reviewOpen && (
              <ProposalReview
                proposals={proposals}
                busy={streaming}
                onApply={applyProposal}
                onDiscard={discardProposal}
                onApplyAll={applyAllProposals}
                onClose={() => setReviewOpen(false)}
              />
            )}
          </div>

          <div className="border-t border-app-border p-2.5 space-y-2">
            {/* What this next message is for. The chip is the whole of the
              * "/lensedit" idea made visible: the reader can see which tool is
              * loaded and take it off again, rather than hoping the model read
              * their intent correctly. */}
            {armed && (
              <div
                className="flex items-center gap-1.5 text-[11px] rounded-md bg-accent/[0.07] border border-accent/40 px-2 py-1.5"
                data-testid="armed-chip"
              >
                {armed.tool === 'lens.propose' ? <Wand2 size={13} className="text-accent shrink-0" />
                  : <Pin size={13} className="text-accent shrink-0" />}
                <span className="text-accent font-bold shrink-0">{armLabel(armed)}</span>
                <span className="flex-1 min-w-0 truncate text-muted">
                  {armIncomplete(armed)
                    ? 'nothing selected — pick a passage first'
                    : 'the assistant will use this tool for your next message'}
                </span>
                {armed.tool === 'lens.propose' && (
                  <button
                    onClick={() => setLensModalOpen(true)}
                    className="px-1.5 py-0.5 rounded hover:bg-app-text/10 shrink-0 text-accent"
                    title="Change the selection"
                  >
                    edit
                  </button>
                )}
                <button
                  onClick={() => setArmed(null)}
                  className="p-0.5 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 shrink-0"
                  title="Cancel — send an ordinary message instead"
                >
                  <X size={13} />
                </button>
              </div>
            )}
            {/* Rewrites waiting on a yes. Deliberately in the composer rather
              * than only behind a button: an unreviewed proposal is work the
              * reader asked for that has not landed, and burying it reads as
              * the assistant having done nothing. */}
            {pendingCount > 0 && !reviewOpen && (
              <button
                onClick={() => setReviewOpen(true)}
                data-testid="pending-proposals"
                className="w-full flex items-center gap-1.5 text-[11px] rounded-md bg-emerald-500/10 border border-emerald-500/40 px-2 py-1.5 hover:bg-emerald-500/15"
              >
                <Wand2 size={13} className="text-emerald-400 shrink-0" />
                <span className="font-bold text-emerald-400 shrink-0">
                  {pendingCount} suggested edit{pendingCount === 1 ? '' : 's'}
                </span>
                <span className="flex-1 min-w-0 truncate text-muted text-left">
                  waiting for you to accept or reject
                </span>
                <span className="text-accent shrink-0">review</span>
              </button>
            )}
            {lensMode && (
              <div className="flex items-center gap-1.5 text-[11px] rounded-md bg-accent/[0.07] border border-accent/40 px-2 py-1.5">
                <Wand2 size={13} className="text-accent shrink-0" />
                <span className="text-accent font-bold shrink-0">Lens edit</span>
                <span className="text-muted shrink-0">→ #</span>
                <input
                  type="number"
                  min={1}
                  max={flat.length}
                  value={lensTarget?.index ?? ''}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    const f = flat.find(x => x.index === n);
                    if (f) setLensTargetId(f.msg.id);
                  }}
                  className="w-12 bg-app-text/5 border border-app-border rounded px-1 py-0.5 outline-none focus:border-accent/50"
                />
                <button onClick={() => moveTarget(-1)} className="p-0.5 rounded hover:bg-app-text/10" title="Previous message"><ChevronLeft size={13} /></button>
                <button onClick={() => moveTarget(1)} className="p-0.5 rounded hover:bg-app-text/10" title="Next message"><ChevronRight size={13} /></button>
                <span className="flex-1 min-w-0 truncate text-muted" title={lensTarget?.msg.content}>
                  {lensTarget ? `${lensTarget.msg.name}: ${lensTarget.msg.content.replace(/\s+/g, ' ').slice(0, 40)}` : 'no message selected'}
                </span>
                <button onClick={() => { setLensMode(false); store.setLensEditFocus(null); }} className="p-0.5 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 shrink-0" title="Exit Lens edit"><X size={13} /></button>
              </div>
            )}
            {/* A span the reader framed on the page. Shown, never implied: this
              * is what will be quoted to the model, so they get to read it and
              * to take it off again. */}
            {lensMode && store.lensEditFocus && (
              <div
                className="flex items-center gap-1.5 text-[11px] rounded-md bg-app-text/5 border border-app-border px-2 py-1.5"
                data-testid="lens-focus"
              >
                <span className="opacity-60 shrink-0">On</span>
                <span className="flex-1 min-w-0 truncate italic" title={store.lensEditFocus}>
                  &ldquo;{store.lensEditFocus.replace(/\s+/g, ' ')}&rdquo;
                </span>
                <button
                  onClick={() => store.setLensEditFocus(null)}
                  className="p-0.5 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100 shrink-0"
                  title="Revise the whole passage instead"
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => store.setAiModel('')}
                  title={`Model: ${store.aiModel} — click to reconfigure`}
                  className="text-[10px] max-w-[64px] truncate px-2 py-1 rounded-md bg-app-text/5 hover:bg-app-text/10"
                >
                  {store.aiModel}
                </button>
                <button
                  onClick={() => setLensModalOpen(true)}
                  title="Lens edit — search the story, pick passages, review every rewrite before it goes in"
                  data-testid="lens-modal-open"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    lensModalOpen || armed?.tool === 'lens.propose'
                      ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <Wand2 size={15} />
                </button>
                {/* The pin equivalent of arming a Lens edit: it does not make
                  * anything, it tells the assistant that the next message is a
                  * request for a pin rather than a question about one. */}
                <button
                  onClick={() => setArmed(a => (a?.tool === 'pins.create' ? null : { tool: 'pins.create' }))}
                  title="Make a pin — the assistant writes your next message into a new pin"
                  aria-pressed={armed?.tool === 'pins.create'}
                  data-testid="arm-pin"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    armed?.tool === 'pins.create' ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <Pin size={15} />
                </button>
                <button
                  onClick={() => setCowriteOpen(v => !v)}
                  title="Cowrite — rank, blend, or check branches with a preset"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    cowriteOpen ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <Combine size={15} />
                </button>
                <button
                  onClick={() => setSummarizeOpen(v => !v)}
                  title="Summarize the whole story into a versioned pin"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    summarizeOpen ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <ScrollText size={15} />
                </button>
                <button
                  onClick={() => setTasksOpen(v => !v)}
                  title="Tasks — read zones in order into one document"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    tasksOpen ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                  data-testid="tasks-toggle"
                >
                  <ListOrdered size={15} />
                </button>
                <button
                  onClick={() => store.setAiAgentMode(!store.aiAgentMode)}
                  title={store.aiAgentMode
                    ? 'Tools on — the assistant can look things up and update pins'
                    : 'Tools off — the assistant can only answer'}
                  aria-pressed={store.aiAgentMode}
                  data-testid="agent-toggle"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    store.aiAgentMode ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <Wrench size={15} />
                </button>
                <button
                  onClick={() => setAdvancedOpen(v => !v)}
                  title="Advanced generation settings"
                  className={cn(
                    'p-1.5 rounded-md hover:bg-app-text/10',
                    advancedOpen ? 'text-accent bg-accent/10' : 'opacity-60 hover:opacity-100',
                  )}
                >
                  <SlidersHorizontal size={15} />
                </button>
              </div>
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
                }}
                placeholder={armed ? armPlaceholder(armed)
                  : lensMode ? "Describe the revision (e.g. 'rewrite in Spanish')…"
                  : 'Ask about the story…'}
                className="flex-1 resize-none max-h-28 bg-app-text/5 border border-app-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/50"
              />
              {streaming ? (
                <button
                  onClick={stop}
                  title="Stop generating"
                  className="p-2 rounded-lg bg-app-text/10 hover:bg-app-text/20 shrink-0"
                >
                  <Square size={16} className="fill-current" />
                </button>
              ) : (
                <button
                  onClick={() => send(input)}
                  disabled={!input.trim()}
                  className="p-2 rounded-lg bg-accent text-white disabled:opacity-40 shrink-0"
                  title={lensMode ? 'Generate Lens rewrite' : 'Send'}
                >
                  {lensMode ? <Wand2 size={16} /> : <Send size={16} />}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
    {zoneBuilderOpen && storyId && (
      <ContextZoneBuilder
        storyId={storyId}
        onSaved={(id) => { setScope('zones'); setActiveZoneId(id); }}
      />
    )}
    {lensModalOpen && (
      <LensEditModal
        initial={armed?.tool === 'lens.propose' ? armed.targets : undefined}
        busy={streaming}
        onClose={() => setLensModalOpen(false)}
        onArm={(picks, instruction) => {
          setArmed({ tool: 'lens.propose', targets: clampTargets(picks.map(p => p.index)) });
          setLensModalOpen(false);
          // The instruction typed in the modal seeds the composer rather than
          // sending: the reader chose to talk about it, so give them the
          // sentence back with the cursor in it.
          if (instruction) setInput(instruction);
        }}
        onRunNow={(picks, instruction) => { void runLensPicks(picks, instruction); }}
      />
    )}
    </>
  );
};
