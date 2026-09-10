/**
 * The one mount for guided tours.
 *
 * At the app root, because a tour crosses the whole app: it starts in the Tour
 * dialog on the library, switches to the reader, opens a panel, and ends
 * somewhere else entirely. Anything that mounted it inside a screen would
 * unmount it the moment the tour did its job.
 *
 * This is the only place that knows how to ACT on a stop — switching the view,
 * opening the panel. `tours.ts` says what a stop wants and this does it, using
 * the same `openGuidePanel` the AI Tour Guide uses, so the two cannot drift
 * into disagreeing about what "open the codex" means.
 */

import { useCallback } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { openGuidePanel } from '../hooks/useAgentTools';
import { docById } from '../utils/guideDocs';
import { tourById, visibleStops, type TourStop } from '../utils/tours';
import { SpotlightTour } from './SpotlightTour';

export const TourHost = () => {
  const guidedTour = useAppStore(s => s.guidedTour);
  const stepGuidedTour = useAppStore(s => s.stepGuidedTour);
  const endGuidedTour = useAppStore(s => s.endGuidedTour);
  const setViewMode = useAppStore(s => s.setViewMode);
  const currentStory = useAppStore(s => s.currentStory);
  const aiBaseUrl = useAppStore(s => s.aiBaseUrl);
  const aiModel = useAppStore(s => s.aiModel);
  const setCodexFocusId = useAuraV2Store(s => s.setCodexFocusId);

  const prepare = useCallback((stop: TourStop) => {
    if (stop.view) setViewMode(stop.view);
    // `openGuidePanel` returns false for the panels whose open state lives in
    // the component that owns them. That is not an error here — the stop still
    // explains the feature, and the reader is told where it is by the words
    // rather than by the hole. Same limitation the assistant has.
    if (stop.panel) openGuidePanel(stop.panel);
  }, [setViewMode]);

  const openDoc = useCallback((docId: string) => {
    const doc = docById(docId);
    if (!doc) return;
    if (doc.where?.view) setViewMode(doc.where.view);
    if (doc.where?.panel) openGuidePanel(doc.where.panel);
    setCodexFocusId(null);
  }, [setViewMode, setCodexFocusId]);

  if (!guidedTour) return null;
  const tour = tourById(guidedTour.tourId);
  if (!tour) return null;

  const stops = visibleStops(tour, {
    hasStory: !!currentStory,
    aiReady: !!aiBaseUrl && !!aiModel,
  });
  if (!stops.length) return null;

  // A tour that lost stops mid-run — the reader disconnected their endpoint on
  // the AI stop it was standing on — must not index past the end.
  const at = Math.min(guidedTour.at, stops.length - 1);

  return (
    <SpotlightTour
      stops={stops}
      at={at}
      onStep={to => {
        if (to < 0) return;
        if (to >= stops.length) { endGuidedTour(true); return; }
        stepGuidedTour(to);
      }}
      onClose={() => endGuidedTour(false)}
      onFinish={() => endGuidedTour(true)}
      onDoc={openDoc}
      onPrepare={prepare}
      inSample={guidedTour.sample}
    />
  );
};
