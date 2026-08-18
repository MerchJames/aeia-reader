/**
 * Service status, as a thing you can see.
 *
 * Aura talks to three optional local servers and, until now, the only way to
 * find out whether one was answering was to use a feature and watch it fail.
 * The URL box told you what you had typed, which is a different question.
 *
 * Two pieces, both small:
 *  - `ServiceDot` — a live indicator, for use next to an existing field.
 *  - `ServiceRow` — dot, address, what it said, and Recheck; the Settings list.
 *
 * `unset` is drawn as neutral, never as a fault. Every one of these backends is
 * optional by design and the reader who runs none of them is not in an error
 * state.
 */

import { RefreshCw } from 'lucide-react';
import { useAppStore } from '../store';
import { SERVICES } from '../services/registry';
import { useService } from '../services/useService';
import type { ServiceId } from '../services/types';
import { cn } from '../utils/cn';

const DOT: Record<string, string> = {
  unset: 'bg-app-text/25',
  checking: 'bg-amber-400 animate-pulse',
  up: 'bg-emerald-500',
  down: 'bg-red-500',
};

const WORD: Record<string, string> = {
  unset: 'not set up',
  checking: 'checking…',
  up: 'running',
  down: 'not answering',
};

/** The base URL a service is currently using, from the store. */
const useBase = (id: ServiceId): string => useAppStore(s => {
  if (id === 'ai') return s.aiBaseUrl;
  if (id === 'kokoro') return s.kokoroBaseUrl;
  return s.audioBaseUrl;
});

export const ServiceDot = ({ id, className }: { id: ServiceId; className?: string }) => {
  const base = useBase(id);
  const { state, detail } = useService(id, base);
  return (
    <span
      className={cn('inline-block w-2 h-2 rounded-full shrink-0', DOT[state], className)}
      title={`${SERVICES[id].label}: ${WORD[state]}${detail ? ` — ${detail}` : ''}`}
      data-testid={`service-dot-${id}`}
      data-state={state}
      aria-label={`${SERVICES[id].label}: ${WORD[state]}`}
      role="img"
    />
  );
};

export const ServiceRow = ({ id }: { id: ServiceId }) => {
  const def = SERVICES[id];
  const base = useBase(id);
  const { state, detail, recheck } = useService(id, base);
  const shown = base.trim() || def.defaultBase || '';

  return (
    <div
      className="flex items-start gap-2.5 px-2 py-2 rounded-lg border border-app-border/60"
      data-testid={`service-row-${id}`}
      data-state={state}
    >
      <span className={cn('w-2 h-2 rounded-full shrink-0 mt-1.5', DOT[state])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{def.label}</div>
        <div className="text-[11px] text-muted truncate" title={shown}>
          {shown || 'no address set'}
        </div>
        <div className="text-[11px] text-muted">
          {WORD[state]}
          {detail ? ` — ${detail}` : ''}
        </div>
        {/* Its own line: inline with a separator, this wrapped and left the
          * separator hanging at the end of the line above it. */}
        {state === 'down' && (
          <div className="text-[11px] text-muted/70">Set it up in {def.hint}</div>
        )}
      </div>
      <button
        onClick={recheck}
        title={`Check ${def.label} now`}
        aria-label={`Check ${def.label} now`}
        data-testid={`service-recheck-${id}`}
        className="flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-app-border hover:bg-app-text/5 transition-colors shrink-0"
      >
        <RefreshCw size={13} className={cn(state === 'checking' && 'animate-spin')} />
      </button>
    </div>
  );
};

/**
 * The list. Deliberately does NOT hold the URL fields — those stay beside the
 * features they belong to, where a reader setting up read-aloud will actually
 * find them. This answers one question: what is running right now.
 */
export const ServicesSection = () => (
  <div className="flex flex-col gap-2">
    {(Object.keys(SERVICES) as ServiceId[]).map(id => <ServiceRow key={id} id={id} />)}
    <p className="text-[11px] text-muted leading-snug px-1">
      Every one of these is optional and every feature has a path without it — the
      reader imports, reads, performs and exports with all three switched off.
      This is only here so a server that is not answering says so, instead of a
      button that looks fine until you press it.
    </p>
  </div>
);
