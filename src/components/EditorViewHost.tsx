import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useAppStore } from '../store';
import {
  closeEditorView, editorTarget, openEditorView, subscribeEditorTarget,
  type EditorTarget,
} from '../utils/editorTarget';
import { EditorView } from './EditorView';

/** The views that have a selection popover of their own — see `ReaderDisplay`. */
const HAS_POPOVER = ['chat', 'storybook'];

/**
 * The cowriter's editor view, reachable from every view.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `SelectionPopover` is mounted by `ReaderDisplay`, which serves the chat and
 * storybook views. The other nine — Book, Stage, VN, RPG, Script, Panels,
 * Atlas, Sandbox, Workspace — render their own text and have no popover, so
 * selecting words there offers nothing at all. Putting the action only in that
 * menu meant it existed in two views out of eleven, and the reader found it in
 * neither of the ones they read in.
 *
 * So: the popover keeps its button, where it belongs in that menu, and this
 * puts a single small mark beside a selection everywhere else. Both call
 * `openEditorView`, and this mounts the one modal.
 */
export const EditorViewHost = () => {
  const on = useAppStore(s => s.cowriter);
  const view = useAppStore(s => s.viewMode);
  const screen = useAppStore(s => s.screen);
  const base = useAppStore(s => s.aiBaseUrl);
  const model = useAppStore(s => s.aiModel);
  const [target, setTarget] = useState<EditorTarget | null>(editorTarget);
  const [chip, setChip] = useState<{ x: number; y: number; span: string; messageId: string } | null>(null);

  useEffect(() => subscribeEditorTarget(setTarget), []);

  const live = on && !!base && !!model && screen === 'reader';
  const needsChip = live && !HAS_POPOVER.includes(view);

  /*
   * Watch the selection itself rather than a mouseup on some container.
   *
   * Each of these views lays its text out differently and none of them offers a
   * hook to attach to — `selectionchange` is the one signal every one of them
   * produces, because it comes from the document rather than from any view's
   * own markup.
   */
  useEffect(() => {
    if (!needsChip) { setChip(null); return; }
    const onChange = () => {
      const sel = window.getSelection();
      const span = sel?.toString().trim() ?? '';
      // Long enough to be a phrase worth editing, short enough to diff.
      if (!sel || sel.isCollapsed || span.length < 3 || span.length > 600) {
        setChip(null);
        return;
      }
      let node: Node | null = sel.anchorNode;
      let messageId: string | undefined;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement && node.dataset.msgId) { messageId = node.dataset.msgId; break; }
        if (node instanceof HTMLElement && node.dataset.msg) { messageId = node.dataset.msg; break; }
        node = node.parentNode;
      }
      if (!messageId) { setChip(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setChip({ x: rect.left + rect.width / 2, y: rect.top, span, messageId });
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [needsChip]);

  return (
    <>
      {chip && !target && (
        <button
          onMouseDown={(e) => e.preventDefault()}   // keep the selection alive
          onClick={() => {
            openEditorView({ span: chip.span, messageId: chip.messageId });
            setChip(null);
          }}
          data-testid="editor-view-chip"
          title="What would your cowriter do with these words?"
          className="fixed z-[70] -translate-x-1/2 -translate-y-full flex items-center gap-1.5
            px-2.5 min-h-9 rounded-full border border-amber-500/40 bg-app-surface text-amber-400
            text-xs shadow-xl hover:bg-amber-500/10"
          style={{ left: chip.x, top: chip.y - 8 }}
        >
          <Pencil size={12} /> Editor’s view
        </button>
      )}
      {target && (
        <EditorView
          span={target.span}
          messageId={target.messageId}
          onClose={closeEditorView}
        />
      )}
    </>
  );
};
