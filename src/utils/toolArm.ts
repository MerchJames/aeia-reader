/**
 * Telling the assistant which tool this message is for.
 *
 * ── Why arming beats asking ────────────────────────────────────────────────
 *
 * With tools on, a model decides for itself whether "make her colder in message
 * 12" is a request to rewrite something or a request to talk about rewriting
 * something. Small local models get that wrong constantly — they answer with a
 * paragraph of advice about coldness, and the reader has to say "no, actually DO
 * it", sometimes twice.
 *
 * Arming removes the decision. The reader picks the tool from the composer, the
 * way they'd pick a slash command, and the directive below goes into the system
 * prompt for that one turn: *this* tool, *these* messages, now. The model still
 * writes the content — it just doesn't get to choose the verb.
 *
 * ── One turn only ──────────────────────────────────────────────────────────
 *
 * An arm is spent when the message is sent. A tool that stayed armed would turn
 * the next ordinary question into another rewrite, which is exactly the failure
 * arming exists to prevent, only harder to notice.
 *
 * Pure: no store, no React. The strings here are the whole contract with the
 * model, so they are tested rather than trusted.
 */

/** The tools a reader can point at directly. Reads are never armed — they don't need it. */
export type ArmedTool =
  | { tool: 'lens.propose'; targets: number[] }
  | { tool: 'pins.create' }
  | { tool: 'pins.newVersion'; pinId: string; title: string };

export type ArmName = ArmedTool['tool'];

/** What the composer chip says. */
export const armLabel = (arm: ArmedTool): string => {
  switch (arm.tool) {
    case 'lens.propose':
      return arm.targets.length === 1
        ? `Lens edit → #${arm.targets[0]}`
        : `Lens edit → ${arm.targets.length} messages`;
    case 'pins.create':
      return 'New pin';
    case 'pins.newVersion':
      return `Update pin — ${arm.title}`;
  }
};

/** What the composer's input asks for while this is armed. */
export const armPlaceholder = (arm: ArmedTool): string => {
  switch (arm.tool) {
    case 'lens.propose':
      return 'What should change? (e.g. "make her colder", "cut the last paragraph")';
    case 'pins.create':
      return 'What should the pin hold? (e.g. "a cast list with one line each")';
    case 'pins.newVersion':
      return 'What should change in the pin?';
  }
};

/**
 * The instruction added to the system prompt for one turn.
 *
 * Written as an order rather than a hint. A 7B model reading "you may wish to
 * consider using lens.propose" will consider it and then not do it; the same
 * model reading "You MUST call lens.propose" calls it.
 *
 * The targets are listed explicitly and by number because the alternative —
 * letting the model infer which message "this one" means from the conversation
 * — is where it picks the wrong one, and the wrong one is a rewrite of a
 * passage the reader never mentioned.
 */
export const armDirective = (arm: ArmedTool): string => {
  const head = '--- THE READER HAS CHOSEN A TOOL ---';
  switch (arm.tool) {
    case 'lens.propose': {
      const list = arm.targets.map(n => `#${n}`).join(', ');
      const plural = arm.targets.length > 1;
      return [
        head,
        `This turn is a LENS EDIT of message${plural ? 's' : ''} ${list}. The reader has already`,
        'chosen the passage. Do not ask which one, and do not rewrite any other.',
        '',
        'Do this, in order:',
        `1. Call story.read to fetch ${plural ? 'each message' : `message ${list}`} exactly as ${plural ? 'they are' : 'it is'} now.`,
        `2. Call lens.propose once for each${plural ? ' of them' : ''}, with the COMPLETE rewritten passage.`,
        '3. Say in one or two sentences what you changed.',
        '',
        'Your rewrite is a suggestion. The reader sees it beside the original and',
        'accepts or rejects it. Never claim the story has been changed.',
        plural ? 'One tool call per reply — propose them one at a time.' : '',
      ].filter(Boolean).join('\n');
    }
    case 'pins.create':
      return [
        head,
        'This turn makes a NEW PIN. The reader has asked for one, so make it —',
        'do not answer in the chat instead, and do not ask whether they want a pin.',
        '',
        'Do this, in order:',
        '1. Look up whatever you need first (story.read, story.search, zones.build, codex.list).',
        '2. Call pins.create with a short title and the complete content.',
        '3. Say what you made, in one line.',
        '',
        'Check pins.list first if you are unsure whether one already covers this;',
        'if one does, write into it with pins.newVersion instead.',
      ].join('\n');
    case 'pins.newVersion':
      return [
        head,
        `This turn updates the pin "${arm.title}" (id ${arm.pinId}).`,
        '',
        'Do this, in order:',
        `1. Call pins.read on ${arm.pinId} so you are rewriting what is actually there.`,
        '2. Call pins.newVersion with the COMPLETE new text — it replaces the pin.',
        '3. Say what changed, in one line.',
        '',
        'Never send a fragment or a diff as the content. Nothing is overwritten:',
        'the previous version stays, so the reader can step back.',
      ].join('\n');
  }
};

/**
 * Arming implies tools, whether or not the toggle is on.
 *
 * The reader who picks "Lens edit" from the composer has asked for the thing
 * tools do. Making them find a second switch first would be a puzzle, and the
 * failure is silent — the directive goes out, no catalogue goes with it, and
 * the model writes a fenced block that nothing ever parses.
 */
export const armNeedsTools = (arm: ArmedTool | null): boolean => arm !== null;

/** A one-line record of what was armed, for the turn's own label. */
export const armScopeLabel = (arm: ArmedTool): string => {
  switch (arm.tool) {
    case 'lens.propose': return `Lens → ${arm.targets.map(n => `#${n}`).join(', ')}`;
    case 'pins.create': return 'New pin';
    case 'pins.newVersion': return `Pin — ${arm.title}`;
  }
};

/** True when the arm cannot be acted on — a Lens edit with nothing selected. */
export const armIncomplete = (arm: ArmedTool): boolean =>
  arm.tool === 'lens.propose' && arm.targets.length === 0;

/** How many messages one arm may point at. */
export const MAX_ARM_TARGETS = 8;

/**
 * Keep an arm's targets sane: in reading order, no duplicates, capped.
 *
 * The cap is not arbitrary. Each target costs a `story.read` and a
 * `lens.propose` — two steps — and `MAX_STEPS` in the agent loop is 8. Arming
 * twelve messages would run the loop out before it reached the fourth, and the
 * reader would get four rewrites and no explanation of where the rest went.
 */
export const clampTargets = (targets: readonly number[]): number[] =>
  [...new Set(targets.filter(n => Number.isInteger(n) && n > 0))]
    .sort((a, b) => a - b)
    .slice(0, MAX_ARM_TARGETS);
