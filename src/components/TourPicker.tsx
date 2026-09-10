/**
 * Choosing a guided tour.
 *
 * Lives inside the Tour dialog, which is where the reader already goes to be
 * told about the app. Starting one closes that dialog, because the tour runs
 * over the live screen and a modal in front of it would be dimming the thing it
 * is pointing at.
 *
 * A finished tour is marked and still offered. The most common reason to open
 * one is having forgotten it, and hiding what you have already seen is how an
 * app becomes unnavigable for the person who has used it longest.
 */

import { BookOpen, Check, Compass, Lock } from 'lucide-react';
import { useAppStore } from '../store';
import { TOURS, needsSample, tourBlocker, visibleStops } from '../utils/tours';
import { cn } from '../utils/cn';

interface TourPickerProps {
  /** Close whatever is hosting this, so the tour has the screen to itself. */
  onStarted: () => void;
}

export const TourPicker = ({ onStarted }: TourPickerProps) => {
  const currentStory = useAppStore(s => s.currentStory);
  const aiBaseUrl = useAppStore(s => s.aiBaseUrl);
  const aiModel = useAppStore(s => s.aiModel);
  const toursSeen = useAppStore(s => s.toursSeen);
  const startGuidedTour = useAppStore(s => s.startGuidedTour);
  const ctx = { hasStory: !!currentStory, aiReady: !!aiBaseUrl && !!aiModel };

  /**
   * Open the sample first when the tour is about reading and nothing is open.
   *
   * Before the tour starts, not during it: the first stop switches a view and
   * measures an element, and doing that against a library screen that is one
   * render away from being a reader is how a spotlight lands on nothing.
   */
  const start = (id: string, sample: boolean) => {
    startGuidedTour(id, sample);
    onStarted();
  };

  return (
    <div className="space-y-2" data-testid="tour-picker">
      <p className="text-[12px] text-muted">
        Each of these walks you through the live app — switching views, opening panels, and
        dimming everything except the thing being explained. Leave at any point with Escape.
      </p>

      <div className="grid gap-1.5">
        {TOURS.map(tour => {
          const blocker = tourBlocker(tour, ctx);
          const sample = needsSample(tour, ctx);
          const seen = toursSeen.includes(tour.id);
          const count = visibleStops(tour, ctx).length;
          return (
            <button
              key={tour.id}
              disabled={!!blocker}
              data-testid={`tour-${tour.id}`}
              onClick={() => start(tour.id, sample)}
              className={cn(
                'flex items-start gap-2.5 text-left px-2.5 py-2 rounded-lg border border-app-border',
                blocker ? 'opacity-50 cursor-default' : 'hover:bg-app-text/5',
              )}
            >
              <span className="mt-0.5 shrink-0 text-accent">
                {blocker
                  ? <Lock size={13} />
                  : sample
                    ? <BookOpen size={13} />
                    : seen ? <Check size={13} /> : <Compass size={13} />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium">{tour.title}</span>
                  {seen && <span className="text-[10px] text-muted">done</span>}
                  {tour.ai && (
                    <span className="text-[10px] px-1 py-px rounded bg-accent/15 text-accent">AI</span>
                  )}
                </span>
                <span className="block text-[11px] text-muted mt-0.5">
                  {/* The blocker replaces the blurb rather than sitting under it:
                      what the reader needs at that moment is the reason, and two
                      lines of explanation for a button they cannot press is noise. */}
                  {blocker
                    ?? (sample
                      // Said before it happens. A tour that silently replaces
                      // the screen with a story the reader did not open reads
                      // as the app having lost their place.
                      ? `${tour.blurb} · opens a sample chat to show you in`
                      : `${tour.blurb} · ${count} stop${count === 1 ? '' : 's'}`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
