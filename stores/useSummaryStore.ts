import { create } from 'zustand';
import { SummaryPhase } from '../utils/summarizer';

/**
 * Ephemeral progress for a running summarizer job (map-reduce). Not persisted;
 * the finished doc lands in a versioned pin. Only one job runs at a time.
 */
interface SummaryState {
  running: boolean;
  phase: SummaryPhase | 'idle';
  done: number;
  total: number;
  /** Last error, surfaced in the panel. */
  error: string | null;
  begin: () => void;
  step: (phase: SummaryPhase, done: number, total: number) => void;
  fail: (error: string) => void;
  end: () => void;
}

export const useSummaryStore = create<SummaryState>((set) => ({
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  error: null,
  begin: () => set({ running: true, phase: 'mapping', done: 0, total: 0, error: null }),
  step: (phase, done, total) => set({ phase, done, total }),
  fail: (error) => set({ running: false, phase: 'idle', error }),
  end: () => set({ running: false, phase: 'idle' }),
}));
