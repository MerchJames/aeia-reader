/**
 * Where the app's bad news appears.
 *
 * One of these, mounted at the root, listening to `utils/alerts`. Deliberately
 * the only notification surface in the app: a second one would mean a reader
 * has two places to look, and the whole point is that there is somewhere to
 * look at all.
 *
 * ── The choices that matter ────────────────────────────────────────────────
 *
 * **Bottom left, not top right.** Top right is where this app's own tools live
 * and where a reader's eye goes to act. Storage news is not something to act on
 * mid-sentence; it belongs out of the way of the words, in the corner nothing
 * else uses.
 *
 * **A `danger` alert has a dismiss button and no timer.** It is about the
 * reader's work not being saved, and a message like that which disappears on
 * its own is worse than none — it creates the appearance of having been told.
 * The reader closes it when they have read it.
 *
 * **`aria-live="assertive"` for danger, `polite` for the rest.** Someone using
 * a screen reader should be interrupted to hear that their work is not saving,
 * and should not be interrupted to hear that an export finished.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import {
  ALERT_TTL_MS, dropAlert, expireAlerts, onAlert, pushAlert, type Alert,
} from '../utils/alerts';
import { cn } from '../utils/cn';

const TONE = {
  info: {
    icon: CheckCircle2,
    ring: 'border-app-border',
    mark: 'text-app-muted',
  },
  warn: {
    icon: AlertTriangle,
    ring: 'border-amber-500/50',
    mark: 'text-amber-400',
  },
  danger: {
    icon: AlertTriangle,
    ring: 'border-red-500/60',
    mark: 'text-red-400',
  },
} as const;

export const AlertHost = () => {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => onAlert(spec => setAlerts(prev => pushAlert(prev, spec))), []);

  useEffect(() => {
    // One sweep for the whole list rather than a timer per alert: the list is
    // capped at four, and four timers racing to setState is four renders where
    // one will do.
    if (!alerts.some(a => !a.sticky)) return;
    const id = window.setInterval(
      () => setAlerts(prev => {
        const next = expireAlerts(prev);
        return next.length === prev.length ? prev : next;
      }),
      Math.min(ALERT_TTL_MS / 3, 2000),
    );
    return () => window.clearInterval(id);
  }, [alerts]);

  if (!alerts.length) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))]
                 pointer-events-none"
    >
      {alerts.map(alert => {
        const tone = TONE[alert.tone];
        const Icon = tone.icon;
        return (
          <div
            key={alert.id}
            role="status"
            aria-live={alert.tone === 'danger' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex gap-2.5 p-3 rounded-xl border shadow-lg',
              'bg-app-surface text-app-text', tone.ring,
            )}
          >
            <Icon size={16} className={cn('shrink-0 mt-0.5', tone.mark)} />
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug">
                {alert.title}
                {alert.count > 1 && (
                  <span className="ml-1.5 text-[11px] text-app-muted tabular-nums">
                    ×{alert.count}
                  </span>
                )}
              </p>
              {alert.detail && (
                <p className="mt-1 text-xs text-app-muted leading-relaxed">{alert.detail}</p>
              )}
            </div>
            <button
              onClick={() => setAlerts(prev => dropAlert(prev, alert.id))}
              className="shrink-0 self-start p-1 -m-1 rounded text-app-muted hover:text-app-text"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
