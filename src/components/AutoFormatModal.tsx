import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ChevronDown, ChevronUp, Download, Eye, EyeOff, Loader2, Plus, Trash2, Sparkles, Upload, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { chatCompletion } from '../utils/aiClient';
import { AutoFormatRule, RuleTarget, StatDisplay, StatRule } from '../types';
import { RPG_SAMPLE_TEXT, RPG_STAT_PRESET, RULE_PRESETS, SAMPLE_TEXT } from '../utils/rulePresets';
import { processText, ruleError } from '../utils/textProcessor';
import { buildStatPanel } from '../utils/statFormatter';
import { downloadText } from '../utils/exporter';
import { cn } from '../utils/cn';

const newRuleId = () => Math.random().toString(36).substring(2, 9);

const TARGET_OPTIONS: { value: RuleTarget; label: string }[] = [
  { value: 'all', label: 'All messages' },
  { value: 'ai', label: 'AI only' },
  { value: 'user', label: 'User only' },
];

const RuleEditor = ({
  rule, index, total,
}: {
  rule: AutoFormatRule;
  index: number;
  total: number;
}) => {
  const store = useAppStore();
  const error = ruleError(rule);

  return (
    <div className={cn(
      'p-4 rounded-xl border bg-app-text/5 space-y-3',
      error ? 'border-red-500/50' : 'border-app-border',
    )}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => store.updateAutoFormatRule(rule.id, { enabled: e.target.checked })}
          title="Enable rule"
        />
        <input
          value={rule.label ?? ''}
          placeholder="Rule name…"
          onChange={(e) => store.updateAutoFormatRule(rule.id, { label: e.target.value })}
          className="flex-1 bg-transparent font-bold text-sm outline-none placeholder:opacity-40 min-w-0"
        />
        <select
          value={rule.appliesTo ?? 'all'}
          onChange={(e) => store.updateAutoFormatRule(rule.id, { appliesTo: e.target.value as RuleTarget })}
          className="text-xs bg-app-text/5 border border-app-border rounded px-1.5 py-1 outline-none"
        >
          {TARGET_OPTIONS.map(o => (
            <option key={o.value} value={o.value} className="text-black bg-white">{o.label}</option>
          ))}
        </select>
        <div className="flex flex-col">
          <button
            onClick={() => store.moveAutoFormatRule(rule.id, -1)}
            disabled={index === 0}
            className="opacity-50 hover:opacity-100 disabled:opacity-15"
            title="Move up (rules run top to bottom)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => store.moveAutoFormatRule(rule.id, 1)}
            disabled={index === total - 1}
            className="opacity-50 hover:opacity-100 disabled:opacity-15"
            title="Move down"
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <button
          onClick={() => store.removeAutoFormatRule(rule.id)}
          className="text-red-500 p-1.5 hover:bg-red-500/10 rounded"
          title="Delete rule"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="grid grid-cols-[1fr_5rem] sm:grid-cols-[3fr_4rem_3fr] gap-2 items-end">
        <div className="min-w-0">
          <label className="text-xs text-muted mb-1 block">Find (regex)</label>
          <input
            value={rule.pattern}
            onChange={(e) => store.updateAutoFormatRule(rule.id, { pattern: e.target.value })}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-sm font-mono"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="text-xs text-muted mb-1 block">Flags</label>
          <input
            value={rule.flags ?? 'g'}
            onChange={(e) => store.updateAutoFormatRule(rule.id, { flags: e.target.value })}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-sm font-mono"
            placeholder="g"
            spellCheck={false}
          />
        </div>
        <div className="col-span-2 sm:col-span-1 min-w-0">
          <label className="text-xs text-muted mb-1 block">Replace with ($1, $2…)</label>
          <input
            value={rule.replacement}
            onChange={(e) => store.updateAutoFormatRule(rule.id, { replacement: e.target.value })}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-sm font-mono"
            spellCheck={false}
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
};

const DISPLAY_OPTIONS: { value: StatDisplay; label: string }[] = [
  { value: 'chips', label: 'Chips' },
  { value: 'table', label: 'Table' },
  { value: 'hide', label: 'Hide' },
];

const StatRuleEditor = ({
  rule, index, total,
}: {
  rule: StatRule;
  index: number;
  total: number;
}) => {
  const store = useAppStore();
  return (
    <div className="p-4 rounded-xl border border-app-border bg-app-text/5 space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => store.updateStatRule(rule.id, { enabled: e.target.checked })}
          title="Enable rule"
        />
        <input
          value={rule.label ?? ''}
          placeholder="Stat rule name…"
          onChange={(e) => store.updateStatRule(rule.id, { label: e.target.value })}
          className="flex-1 bg-transparent font-bold text-sm outline-none placeholder:opacity-40 min-w-0"
        />
        <select
          value={rule.display}
          onChange={(e) => store.updateStatRule(rule.id, { display: e.target.value as StatDisplay })}
          className="text-xs bg-app-bg border border-app-border rounded px-1.5 py-1 outline-none"
        >
          {DISPLAY_OPTIONS.map(o => (
            <option key={o.value} value={o.value} className="text-black bg-white">{o.label}</option>
          ))}
        </select>
        <div className="flex flex-col">
          <button
            onClick={() => store.moveStatRule(rule.id, -1)}
            disabled={index === 0}
            className="opacity-50 hover:opacity-100 disabled:opacity-15"
            title="Move up"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => store.moveStatRule(rule.id, 1)}
            disabled={index === total - 1}
            className="opacity-50 hover:opacity-100 disabled:opacity-15"
            title="Move down"
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <button
          onClick={() => store.removeStatRule(rule.id)}
          className="text-red-500 p-1.5 hover:bg-red-500/10 rounded"
          title="Delete rule"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div>
        <label className="text-xs text-muted mb-1 block">Pattern (use {'{key}'} and {'{value}'})</label>
        <input
          value={rule.pattern}
          onChange={(e) => store.updateStatRule(rule.id, { pattern: e.target.value })}
          className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-sm font-mono"
          placeholder="[{key}] {value}"
          spellCheck={false}
        />
      </div>
    </div>
  );
};

export const AutoFormatModal = ({ onClose }: { onClose: () => void }) => {
  const store = useAppStore();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [importError, setImportError] = useState('');
  const [reformatting, startReformat] = useTransition();
  const [reformatProgress, setReformatProgress] = useState<{ done: number; total: number } | null>(null);
  const [reformatScope, setReformatScope] = useState<'all' | 'page' | 'ahead'>('all');
  const abortRef = useRef<AbortController | null>(null);

  // Closing the Studio must stop a running reformat — otherwise it keeps
  // hitting the model in the background with no visible way to cancel.
  useEffect(() => () => abortRef.current?.abort(), []);

  const defaultSample = useMemo(() => {
    const firstAi = store.currentStory?.messages.find(m => m.role === 'ai');
    return firstAi ? firstAi.content.slice(0, 400) : SAMPLE_TEXT;
  }, [store.currentStory]);
  const [sample, setSample] = useState(defaultSample);

  const preview = useMemo(() => {
    const { entries, prose } = buildStatPanel(sample, store.statRules);
    const processed = processText(prose, {
      hideMetadata: store.hideMetadata,
      autoFormat: true,
      autoFormatRules: store.autoFormatRules,
      paragraphSpacing: store.paragraphSpacing,
      dialogueOwnLine: store.dialogueOwnLine,
      smartTypography: store.smartTypography,
      styleQuotes: store.styleQuotes,
      substituteNames: store.substituteNames,
      characterName: store.currentStory?.characterName ?? 'Elara',
      userName: store.currentStory?.userName ?? 'James',
      role: 'ai',
    }).processedText;
    const stats = entries.length
      ? `--- Stats (${entries.length}) ---\n${entries.map(e => `${e.key}: ${e.value}`).join('\n')}\n\n`
      : '';
    return stats + processed;
  }, [sample, store]);

  const addBlankRule = () =>
    store.addAutoFormatRule({
      id: newRuleId(), label: '', pattern: '', flags: 'g', replacement: '',
      appliesTo: 'all', enabled: true,
    });

  const addBlankStatRule = () =>
    store.addStatRule({
      id: newRuleId(), label: '', pattern: '[{key}] {value}', display: 'chips', enabled: true,
    });

  // One-click demo: load the RPG tracker rules and drop matching sample text
  // into the preview so the reader can see stat chips/bars appear immediately.
  const loadRpgExample = () => {
    const have = new Set(store.statRules.map(r => r.label));
    RPG_STAT_PRESET.forEach(p => {
      if (!have.has(p.label)) {
        store.addStatRule({ id: newRuleId(), label: p.label, pattern: p.pattern, display: p.display, enabled: true });
      }
    });
    setSample(RPG_SAMPLE_TEXT);
    setShowPreview(true);
  };

  const addPreset = (presetIndex: number) => {
    const preset = RULE_PRESETS[presetIndex];
    store.addAutoFormatRule({ ...preset, id: newRuleId(), enabled: true });
    setShowPresets(false);
  };

  const exportRules = () =>
    downloadText('aura-reader-rules.json', JSON.stringify(store.autoFormatRules, null, 2));

  const importRules = async (file: File) => {
    setImportError('');
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('not an array');
      const rules: AutoFormatRule[] = parsed
        .filter((r: any) => r && typeof r.pattern === 'string' && typeof r.replacement === 'string')
        .map((r: any) => ({
          id: typeof r.id === 'string' ? r.id : newRuleId(),
          label: typeof r.label === 'string' ? r.label : undefined,
          pattern: r.pattern,
          flags: typeof r.flags === 'string' ? r.flags : 'g',
          replacement: r.replacement,
          appliesTo: ['all', 'ai', 'user'].includes(r.appliesTo) ? r.appliesTo : 'all',
          enabled: r.enabled !== false,
        }));
      if (rules.length === 0) throw new Error('no valid rules found');
      store.importAutoFormatRules(rules);
    } catch (e: any) {
      setImportError(`Import failed: ${e?.message ?? 'invalid file'}`);
    }
  };

  const aiConfigured = !!(store.aiBaseUrl && store.aiModel);
  const runAiReformat = () => {
    if (!aiConfigured || !store.currentStory) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    startReformat(async () => {
      const app = useAppStore.getState();
      const v2 = useAuraV2Store.getState();
      const storyId = app.currentStory!.id;
      const existing = new Set((v2.overridesByStory[storyId] ?? [])
        .filter(o => o.kind === 'format')
        .map(o => o.messageId));
      // Narrow to the chosen scope: whole story, the current page, or from the
      // reader's current message onward.
      const scoped = (() => {
        const flat = app.chains.flatMap(c => c.messages);
        if (reformatScope === 'page') return app.chains[app.currentChainIndex]?.messages ?? [];
        if (reformatScope === 'ahead') {
          const curId = app.chains[app.currentChainIndex]?.messages[app.currentMessageIndex]?.id;
          const idx = curId ? flat.findIndex(m => m.id === curId) : 0;
          return idx >= 0 ? flat.slice(idx) : flat;
        }
        return flat;
      })();
      // Hidden/system entries (trackers, /hide-den lines) are structured data,
      // not prose — reformatting them destroys more than it cleans.
      const messages = scoped.filter(m => !existing.has(m.id) && !m.hidden);
      const total = messages.length;
      if (total === 0) return;
      setReformatProgress({ done: 0, total });
      const system =
        'Reformat the following roleplay message for readability. Do NOT rewrite prose, change voice/POV, or remove content. '
        + 'Only clean up stat-block noise like [Key] value tokens into readable prose or a tidy list. '
        + 'Return ONLY the reformatted message text, no quotes or explanation.';
      for (let i = 0; i < total; i++) {
        if (signal.aborted) break;
        const m = messages[i];
        try {
          const text = (await chatCompletion(app.aiBaseUrl, app.aiApiKey, app.aiModel, [
            { role: 'system', content: system },
            { role: 'user', content: m.content },
          ], {}, signal)).trim();
          // The prompt forbids removing content — a reply that's empty or
          // dramatically shorter means the model misbehaved; keep the original.
          const destructive = !text
            || (m.content.length > 80 && text.length < m.content.length * 0.4);
          if (!destructive) {
            v2.setOverride(storyId, {
              messageId: m.id,
              kind: 'format',
              content: text,
              source: 'ai',
              note: 'AI reformat',
              createdAt: Date.now(),
            });
          }
        } catch (e) {
          console.warn('AI reformat failed for message', m.id, e);
        }
        setReformatProgress({ done: i + 1, total });
      }
      setReformatProgress(null);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface text-app-text rounded-2xl w-full max-w-3xl max-h-[85dvh] flex flex-col shadow-2xl border border-app-border">
        <div className="flex items-center justify-between p-5 border-b border-app-border">
          <div>
            <h2 className="text-xl font-bold">Formatting Studio</h2>
            <p className="text-sm text-muted">
              Regex find &amp; replace, stat-token panels, and one-shot AI reformatting.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="file"
              accept=".json"
              ref={importInputRef}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importRules(f);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              title="Import rules (.json)"
              className="p-2 hover:bg-app-text/10 rounded-lg transition-colors"
            >
              <Upload size={17} />
            </button>
            <button
              onClick={exportRules}
              title="Export rules (.json)"
              disabled={store.autoFormatRules.length === 0}
              className="p-2 hover:bg-app-text/10 rounded-lg transition-colors disabled:opacity-30"
            >
              <Download size={17} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-app-text/10 rounded-full transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {importError && <p className="text-sm text-red-500">{importError}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={addBlankRule}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
            >
              <Plus size={15} /> New rule
            </button>
            <div className="relative">
              <button
                onClick={() => setShowPresets(!showPresets)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
              >
                Add preset <ChevronDown size={14} />
              </button>
              {showPresets && (
                <div className="absolute left-0 top-full mt-1 z-10 w-80 max-h-72 overflow-y-auto rounded-xl border border-app-border bg-surface shadow-2xl p-1">
                  {RULE_PRESETS.map((preset, i) => (
                    <button
                      key={preset.label}
                      onClick={() => addPreset(i)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-app-text/5"
                    >
                      <span className="block text-sm font-bold">{preset.label}</span>
                      <span className="block text-xs text-muted">{preset.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!store.autoFormat && (
              <span className="text-xs text-amber-500 ml-auto">
                Auto-Format is currently off — rules won't run.
              </span>
            )}
          </div>

          {store.autoFormatRules.length === 0 ? (
            <p className="text-sm text-muted italic">
              No rules yet. Add a preset to see how they work.
            </p>
          ) : (
            <div className="space-y-3">
              {store.autoFormatRules.map((rule, i) => (
                <RuleEditor key={rule.id} rule={rule} index={i} total={store.autoFormatRules.length} />
              ))}
            </div>
          )}

          <div className="border-t border-app-border pt-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted">Stat Rules</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadRpgExample}
                  title="Add an example RPG tracker (Health/Mana/Stamina bars, status, location, outfit…) and preview it"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/50 text-accent text-sm hover:bg-accent/10"
                >
                  <Sparkles size={15} /> Load RPG example
                </button>
                <button
                  onClick={addBlankStatRule}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
                >
                  <Plus size={15} /> New stat rule
                </button>
              </div>
            </div>
            {store.statRules.length === 0 ? (
              <p className="text-sm text-muted italic">
                No stat rules yet. Hit <b>Load RPG example</b> to see <code>[Health] 100</code>,
                <code>[Status]</code>, <code>[Outfit]</code>… tokens turn into stat chips &amp; bars — or
                add your own to pull [Key] value tokens out of messages.
              </p>
            ) : (
              <div className="space-y-3">
                {store.statRules.map((rule, i) => (
                  <StatRuleEditor key={rule.id} rule={rule} index={i} total={store.statRules.length} />
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-app-border pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted">AI Reformat</h3>
              {!aiConfigured && (
                <span className="text-xs text-muted">Configure AI in Settings to enable.</span>
              )}
            </div>
            <p className="text-sm text-muted mb-3">
              One-shot fallback: ask the AI to clean up messy stat-block messages and write the result as Lens format overrides. Skips messages that already have a format override.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={reformatScope}
                onChange={(e) => setReformatScope(e.target.value as 'all' | 'page' | 'ahead')}
                disabled={reformatting}
                title="Which messages to reformat"
                className="text-sm bg-app-text/5 border border-app-border rounded-lg px-2 py-1.5 outline-none disabled:opacity-40"
              >
                <option value="all" className="text-black bg-white">Whole story</option>
                <option value="page" className="text-black bg-white">This page only</option>
                <option value="ahead" className="text-black bg-white">From current message on</option>
              </select>
              <button
                onClick={runAiReformat}
                disabled={!aiConfigured || reformatting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-40"
              >
                {reformatting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {reformatting ? 'Reformatting…' : 'Reformat with AI'}
              </button>
              {reformatting && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/50 text-red-500 text-sm font-medium hover:bg-red-500/10"
                >
                  <X size={15} /> Stop
                </button>
              )}
            </div>
            {reformatProgress && (
              <div className="mt-3 text-xs text-muted">
                Processed {reformatProgress.done} / {reformatProgress.total} messages
              </div>
            )}
          </div>

          <div className="border-t border-app-border pt-4">
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted mb-3"
            >
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />} Live preview
            </button>
            {showPreview && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted mb-1 block">Sample input</label>
                  <textarea
                    value={sample}
                    onChange={(e) => setSample(e.target.value)}
                    rows={8}
                    spellCheck={false}
                    className="w-full bg-app-bg border border-app-border rounded-lg p-2.5 text-xs font-mono resize-y"
                  />
                </div>
                <div className="min-w-0">
                  <label className="text-xs text-muted mb-1 block">
                    Result (with current text settings)
                  </label>
                  <pre className="w-full h-[calc(100%-1.25rem)] min-h-40 bg-app-bg border border-app-border rounded-lg p-2.5 text-xs font-mono whitespace-pre-wrap overflow-y-auto">
                    {preview}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
