/**
 * The last thing between a render error and a black window.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * In a browser tab that leaves a white page and a console entry; in a packaged
 * desktop app it leaves a **black window with nothing in it and no console to
 * open**, which is what a stored setting of the wrong shape did to this app.
 * From the outside those are indistinguishable from a hang, a failed launch, or
 * a corrupt install.
 *
 * So: catch it, say what broke, and offer the two things that actually recover
 * a reader — reload, and clear the settings that are most likely to be the
 * cause. Their stories are in IndexedDB and are never touched by either.
 *
 * ── Why it does not just clear everything ──────────────────────────────────
 *
 * A "reset the app" button that wipes the library would turn a five-minute bug
 * into a lost archive. The reset here removes ONE localStorage key — the
 * settings blob — and says so before it does it.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
  info: string;
}

export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still logged: a reader who can open a console should find the real stack,
    // and this screen only shows the part that fits.
    console.error('[Aeia] render failed', error, info);
    this.setState({ info: (info.componentStack ?? '').split('\n').slice(0, 6).join('\n') });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        // Deliberately inline and literal. A crash can come from anywhere,
        // including the theme layer, so this screen must not depend on a CSS
        // variable or a class that may be exactly what failed.
        background: '#14131a',
        color: '#e8e6ef',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}>
        <div style={{ maxWidth: 560, width: '100%' }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
            Aeia hit an error and stopped drawing.
          </h1>
          <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, margin: '0 0 16px' }}>
            Your stories are not affected — they live in the app's database, and nothing on this
            screen touches it.
          </p>

          <pre style={{
            fontSize: 12,
            background: '#1d1b25',
            border: '1px solid #322f3d',
            borderRadius: 8,
            padding: 12,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            margin: '0 0 16px',
          }}>
            {error.message || String(error)}
            {info ? `\n${info}` : ''}
          </pre>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => window.location.reload()} style={button(true)}>
              Reload
            </button>
            <button
              onClick={() => {
                // One key: the settings blob. Not the library, not the per-story
                // data — a reset that cost somebody their archive would be a far
                // worse bug than the one it was recovering from.
                try { localStorage.removeItem('aura-reader-settings'); } catch { /* denied */ }
                window.location.reload();
              }}
              style={button(false)}
            >
              Reset settings and reload
            </button>
          </div>

          <p style={{ fontSize: 11, opacity: 0.55, marginTop: 14, lineHeight: 1.6 }}>
            Reset clears your preferences — theme, endpoints, pipeline setup. It does not clear
            stories, pins, sheets or anything else you have written.
          </p>
        </div>
      </div>
    );
  }
}

const button = (primary: boolean) => ({
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  cursor: 'pointer',
  border: primary ? '1px solid #6c5ce7' : '1px solid #3a3745',
  background: primary ? '#6c5ce7' : 'transparent',
  color: primary ? '#fff' : '#e8e6ef',
});
