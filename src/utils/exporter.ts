import { MessageOverride, Story } from '../types';
import { AEIA_MARK } from '../assets/aeiaMark';
import { resolveContent } from './lens';

/**
 * The Aeia mark, as a markdown REFERENCE-style image.
 *
 * The mark has to travel as a data URI — an exported file is never allowed to
 * fetch anything — but markdown is a format people read as plain text, and
 * thirteen kilobytes of base64 sitting above the title makes the source
 * unreadable in an editor. A reference definition puts the payload at the
 * bottom of the file, out of the reading path, and renders identically.
 */
const MARK_REF = 'aeia-reader-mark';

export const storyToMarkdown = (story: Story, exportedAt = Date.now()): string => {
  const lines: string[] = [`![Aeia Reader][${MARK_REF}]`, '', `# ${story.title}`, ''];
  if (story.characterName || story.userName) {
    lines.push(
      [
        story.characterName ? `**Character:** ${story.characterName}` : null,
        story.userName ? `**User:** ${story.userName}` : null,
      ].filter(Boolean).join(' · '),
      '',
    );
  }

  const words = story.messages.reduce((n, m) => n + (m.content.match(/\S+/g)?.length ?? 0), 0);
  let date: string;
  try {
    date = new Date(exportedAt).toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { date = new Date(exportedAt).toISOString().slice(0, 10); }
  lines.push(
    `*${story.messages.length.toLocaleString()} passages · ${words.toLocaleString()} words`
      + ` · exported from Aeia Reader on ${date}*`,
    '',
    '---',
    '',
  );

  story.messages.forEach(msg => {
    if (story.format !== 'kobold') lines.push(`### ${msg.name}`, '');
    lines.push(msg.content.trim(), '');
  });

  if (story.highlights?.length) {
    lines.push('---', '', '## Highlights', '');
    story.highlights.forEach(h => lines.push(`> ${h.text}`, ''));
  }

  // Last, so the top of the file is the story and not a wall of base64.
  lines.push('', `[${MARK_REF}]: ${AEIA_MARK}`, '');
  return lines.join('\n');
};

export const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

export const safeFilename = (title: string) =>
  title.replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'story';

/**
 * Build an exportable copy of the story with Lens overrides applied.
 * Returns a string in the original format (JSONL for SillyTavern, JSON for Kobold).
 * The source story in storage is never mutated.
 */
export const exportStoryWithEdits = (
  story: Story,
  overrides: MessageOverride[] | undefined,
): string => {
  const messages = story.messages.map(m => ({
    ...m,
    content: resolveContent(m, overrides, true),
  }));

  if (story.format === 'sillytavern') {
    const lines: string[] = [];
    if (story.characterName || story.userName) {
      lines.push(JSON.stringify({
        character_name: story.characterName,
        user_name: story.userName,
      }));
    }
    messages.forEach(m => {
      lines.push(JSON.stringify({
        name: m.name,
        is_user: m.role === 'user',
        mes: m.content,
        is_system: m.hidden,
        swipes: m.swipes,
      }));
    });
    return lines.join('\n');
  }

  if (story.format === 'kobold') {
    return JSON.stringify({
      story_name: story.title,
      actions: messages.map(m => ({
        text: m.content,
        // Preserve a minimal shape even though we don't store Kobold's full metadata.
        ...(m.role === 'user' ? { author: 'user' } : {}),
      })),
    }, null, 2);
  }

  // Fallback: generic JSON dump of the story with overrides applied.
  return JSON.stringify({ ...story, messages }, null, 2);
};

export const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
