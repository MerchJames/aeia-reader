import React, { useMemo, useState, useTransition } from 'react';
import { Bot, Check, Loader2, MessageSquare, Pencil, Send, X } from 'lucide-react';
import { useAppStore } from '../store';
import {
  committedCount, flatMessages, useAuraV2Store, visibleEntities,
} from '../stores/useAuraV2Store';
import { askText } from '../utils/aiCall';
import { cardToPromptBlock, pinsToPromptBlock, sheetsToPromptBlock } from '../utils/cardContext';
import { cn } from '../utils/cn';
import { resolveContent } from '../utils/lens';

const THREAD_SYSTEM =
  'You are a careful second pair of eyes for someone reading a story. Answer questions '
  + 'about the quoted passage using ONLY the provided context blocks. When asked whether '
  + 'something makes sense or is consistent, check it against the character card, tracking '
  + 'sheets, and known lore, and point out contradictions plainly. Never reveal, invent, or '
  + 'speculate about events beyond the provided excerpt. Be concise: 2–5 sentences.';

/**
 * Everything the AI needs to be a useful second pair of eyes, without
 * spoiling: the card, the reader's sheets, lore they have already met,
 * and a few messages of read-so-far context around the anchor.
 */
const buildGrounding = (storyId: string, messageId: string, resolved: string, anchorText?: string): string => {
  const s = useAppStore.getState();
  const v2 = useAuraV2Store.getState();
  const msgs = flatMessages(s.chains);
  const i = msgs.findIndex(m => m.id === messageId);
  const before = i > 0 ? msgs.slice(Math.max(0, i - 3), i) : [];
  const excerpt = [
    ...before.map(m => `${m.name}: ${m.content.slice(0, 900)}`),
    `>>> ${msgs[i]?.name ?? ''}: ${resolved.slice(0, 2400)}`,
  ].join('\n\n');

  const readCount = s.chains.length === 0
    ? 0
    : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage);
  const haystack = `${anchorText ?? ''} ${resolved}`.toLowerCase();
  const lore = visibleEntities(v2.codexByStory[storyId] ?? [], readCount)
    .filter(e => haystack.includes(e.name.toLowerCase()))
    .slice(0, 8);
  const loreBlock = lore.length
    ? [
        '--- KNOWN LORE (the reader has already met these) ---',
        ...lore.map(e => `${e.kind} — ${e.name}: ${e.summary || '(no summary yet)'}`),
      ].join('\n')
    : '';

  return [
    cardToPromptBlock(s.currentStory?.card),
    sheetsToPromptBlock(v2.sheetsByStory[storyId]),
    pinsToPromptBlock(v2.pinsByStory[storyId]),
    loreBlock,
    '--- STORY EXCERPT (read so far; ">>>" marks the discussed message) ---',
    excerpt,
  ].filter(Boolean).join('\n\n');
};

/**
 * Scoped thread anchored to one passage — margin-comment idiom, not a chat
 * tab. Ask about the passage and the AI answers grounded in the card,
 * sheets, and known lore; "Suggest rewrite" turns the discussion into a
 * Lens override the reader explicitly accepts. Everything persists as
 * annotations pinned to the message.
 */
export const AnnotationThread = ({ messageId, anchorText, onClose }: {
  messageId?: string;
  anchorText?: string;
  onClose: () => void;
}) => {
  const story = useAppStore(s => s.currentStory);
  const v2 = useAuraV2Store();
  const storyId = story?.id;
  const annotations = storyId ? v2.annotationsByStory[storyId] ?? [] : [];
  const overrides = storyId ? v2.overridesByStory[storyId] ?? [] : [];
  const lensOn = !!storyId && !!v2.lensOnByStory[storyId];

  const message = useMemo(() => {
    if (!messageId) return null;
    const s = useAppStore.getState();
    return flatMessages(s.chains).find(m => m.id === messageId) ?? null;
  }, [messageId]);

  const thread = useMemo(
    () => annotations.filter(a => a.messageId === messageId).sort((a, b) => a.createdAt - b.createdAt),
    [annotations, messageId],
  );

  const [input, setInput] = useState('');
  const [aiBusy, startAi] = useTransition();
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggestedRewrite, setSuggestedRewrite] = useState<string | null>(null);
  const aiConfigured = useAppStore(s => !!(s.aiBaseUrl && s.aiModel));

  if (!storyId || !message) return null;

  const resolved = resolveContent(message, overrides, lensOn);

  const send = () => {
    const text = input.trim();
    if (!text || aiBusy) return;
    v2.addAnnotation(storyId, { messageId: message.id, anchorText, note: text, role: 'user' });
    setInput('');
    if (!aiConfigured) return;

    setAiError(null);
    startAi(async () => {
      try {
        const s = useAppStore.getState();
        const grounding = buildGrounding(storyId, message.id, resolved, anchorText);
        // Rebuild the history from the store so it includes the note above.
        const history = (useAuraV2Store.getState().annotationsByStory[storyId] ?? [])
          .filter(a => a.messageId === message.id)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-12)
          .map(a => ({
            role: a.role === 'ai' ? ('assistant' as const) : ('user' as const),
            content: a.note,
          }));
        const reply = await askText({ base: s.aiBaseUrl, key: s.aiApiKey, model: s.aiModel }, [
          { role: 'system', content: `${THREAD_SYSTEM}\n\n${grounding}` },
          ...(anchorText
            ? [{ role: 'user' as const, content: `The passage in question: "${anchorText}"` }]
            : []),
          ...history,
        ], { label: 'Talking it over' });
        useAuraV2Store.getState().addAnnotation(storyId, {
          messageId: message.id, anchorText, note: reply.trim(), role: 'ai',
        });
      } catch (e: any) {
        setAiError(e?.message ?? 'The AI request failed');
      }
    });
  };

  const suggestRewrite = () => {
    if (!aiConfigured || aiBusy) return;
    setAiError(null);
    startAi(async () => {
      try {
        const s = useAppStore.getState();
        const grounding = buildGrounding(storyId, message.id, resolved, anchorText);
        const recentNotes = thread.slice(-6)
          .map(t => `${t.role === 'ai' ? 'AI' : 'Reader'}: ${t.note}`)
          .join('\n');
        const system =
          'You are a writing assistant. Suggest a rewrite for the provided message passage. '
          + 'Preserve voice, POV, formatting, and all established facts; only fix what the '
          + 'discussion (if any) calls out, or improve clarity and flow. '
          + 'Reply ONLY with the rewritten passage, no explanation or markdown quotes.\n\n'
          + grounding;
        const user = anchorText
          ? `Rewrite this passage: "${anchorText}"${recentNotes ? `\n\nDiscussion so far:\n${recentNotes}` : ''}`
          : `Rewrite the ">>>" message.${recentNotes ? `\n\nDiscussion so far:\n${recentNotes}` : ''}`;
        const text = await askText({ base: s.aiBaseUrl, key: s.aiApiKey, model: s.aiModel }, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { label: 'Drafting a rewrite' });
        setSuggestedRewrite(text);
      } catch (e: any) {
        setAiError(e?.message ?? 'The rewrite request failed');
      }
    });
  };

  const acceptRewrite = () => {
    if (!suggestedRewrite) return;
    const nextContent = anchorText && resolved.includes(anchorText)
      ? resolved.replace(anchorText, suggestedRewrite)
      : suggestedRewrite;
    v2.setOverride(storyId, {
      messageId: message.id,
      kind: 'rewrite',
      content: nextContent,
      source: 'ai',
      note: `Rewrite suggested for: ${anchorText ?? 'message'}`,
      createdAt: Date.now(),
    });
    setSuggestedRewrite(null);
    v2.addAnnotation(storyId, {
      messageId: message.id, anchorText, note: `Accepted rewrite: ${suggestedRewrite}`, role: 'ai',
    });
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full sm:w-[28rem] max-h-[80dvh] bg-surface border border-app-border shadow-2xl rounded-t-2xl sm:rounded-2xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <MessageSquare size={17} className="text-accent" />
          <h3 className="font-bold text-sm">Scoped thread</h3>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-app-text/10"><X size={16} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {anchorText && (
            <div className="p-3 rounded-lg bg-app-text/5 border border-app-border text-sm italic opacity-80">
              “{anchorText}”
            </div>
          )}

          {thread.length === 0 && !aiBusy ? (
            <p className="text-sm text-muted text-center py-6">
              {aiConfigured
                ? 'No notes yet. Ask a question about this passage, or request a rewrite.'
                : 'No notes yet. Write one — configure an AI endpoint in Settings to also ask questions here.'}
            </p>
          ) : (
            thread.map(t => (
              <div key={t.id} className={cn('text-sm', t.role === 'ai' && 'border-l-2 border-accent/60 pl-3')}>
                {t.role === 'ai' && (
                  <p className="text-[10px] font-bold uppercase tracking-wider text-accent flex items-center gap-1 mb-0.5">
                    <Bot size={11} /> Second pair of eyes
                  </p>
                )}
                <p className="opacity-90 whitespace-pre-wrap">{t.note}</p>
                <p className="text-[10px] text-muted mt-1">{new Date(t.updatedAt).toLocaleString()}</p>
              </div>
            )))
          }

          {aiBusy && (
            <div className="flex items-center gap-2 text-xs text-muted border-l-2 border-accent/40 pl-3 py-1">
              <Loader2 size={13} className="animate-spin" /> Reading the passage…
            </div>
          )}

          {suggestedRewrite && (
            <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-2">
              <p className="text-xs font-bold text-amber-500 flex items-center gap-1"><Pencil size={12} /> Suggested rewrite</p>
              <p className="text-sm whitespace-pre-wrap">{suggestedRewrite}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={acceptRewrite}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90"
                >
                  <Check size={12} /> Accept & write override
                </button>
                <button
                  onClick={() => setSuggestedRewrite(null)}
                  className="px-2.5 py-1 rounded-lg border border-app-border text-xs hover:bg-app-text/5"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {aiError && <p className="text-xs text-red-500">{aiError}</p>}
        </div>

        <div className="border-t border-app-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(); }}
              placeholder={aiConfigured ? 'Ask about this passage…' : 'Add a note…'}
              className="flex-1 bg-app-text/5 border border-app-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/50"
            />
            <button
              onClick={send}
              disabled={!input.trim() || aiBusy}
              className="p-2 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
          <button
            onClick={suggestRewrite}
            disabled={!aiConfigured || aiBusy}
            className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
          >
            <Bot size={13} />
            Suggest rewrite
          </button>
        </div>
      </div>
    </div>
  );
};
