/**
 * Which words the cowriter has been asked about.
 *
 * ── Why this is a module and not component state ──────────────────────────
 *
 * The ask comes from two places and must open ONE thing. In the chat and
 * storybook views there is a selection popover and the action belongs in its
 * menu; in the other nine views there is no popover at all, so the action has
 * to arrive as its own small affordance.
 *
 * Two buttons, one view. Holding the target in a module means the modal is
 * mounted once at the root and neither caller knows the other exists — the
 * alternative was the same modal rendered in two components, which is two
 * places to fix anything about it.
 *
 * Framework-free, same shape as `peek` and `proxyLink`.
 */

export interface EditorTarget {
  span: string;
  messageId: string;
}

let target: EditorTarget | null = null;
const listeners = new Set<(t: EditorTarget | null) => void>();

const publish = () => { for (const l of listeners) l(target); };

export const editorTarget = (): EditorTarget | null => target;

export const subscribeEditorTarget = (fn: (t: EditorTarget | null) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const openEditorView = (next: EditorTarget): void => {
  target = next;
  publish();
};

export const closeEditorView = (): void => {
  target = null;
  publish();
};
