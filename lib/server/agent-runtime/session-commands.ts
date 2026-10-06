/**
 * Composer commands the runner acts on itself, before the model is involved.
 *
 * ## Why commands and not just the automatic budget
 *
 * The budget is the automatic gear: it compacts when the context crosses a
 * threshold. That leaves the learner without a way to say "compact now" — for
 * example before starting a long new task in a session that is not over budget
 * yet, or in a deployment that deliberately left automatic compaction off.
 * `/compact` is that manual gear.
 *
 * ## Why a text token and not a button
 *
 * The workbench composer's `/` menu is a SKILL registry
 * (`lib/workbench/composer-skills`), not a general command registry: it writes
 * `/skill-handle ` into the draft and the runner preloads the named SKILL.md.
 * Adding a non-skill entry there means touching the composer menu, the pill
 * rendering and the skill-handle parser, all to carry one word. A token the
 * runner recognises is the same UX at a fraction of the blast radius — and it
 * composes with a real request, so `/compact 接着建第 3 页` compacts first and
 * then continues in one turn.
 *
 * ## What this deliberately does not do
 *
 * It does not strip the token from the message. The durable user message is
 * already written by the route that accepted it, and the transcript is rebuilt
 * from durable entries, so rewriting it read-side would make the delivered
 * prompt and the durable record disagree. The model therefore sees the raw
 * token; it is a word, not an instruction, and the compaction it requested has
 * already happened by the time the request goes out.
 */
export const SESSION_COMMANDS = ['compact'] as const;

export type SessionCommandName = (typeof SESSION_COMMANDS)[number];

/**
 * A `/word` token at a word boundary.
 *
 * Anchored on whitespace rather than `\b` because a path like `docs/compact`
 * must not read as a command, and `/compact` at the very start of a message has
 * no leading whitespace to match.
 */
const COMMAND_PATTERN = /(?:^|\s)\/([a-z][a-z0-9-]*)(?=\s|$)/gi;

/**
 * The command a user message carries, or null.
 *
 * Only names in {@link SESSION_COMMANDS} are returned, so a `/skill-handle` in
 * the same message is left for the skill path to handle.
 */
export function readSessionCommand(text: string): SessionCommandName | null {
  for (const match of text.matchAll(COMMAND_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (name && (SESSION_COMMANDS as readonly string[]).includes(name)) {
      return name as SessionCommandName;
    }
  }
  return null;
}

/** The first command across a run's pending user messages, or null. */
export function readSessionCommandFrom(
  texts: readonly (string | undefined)[],
): SessionCommandName | null {
  for (const text of texts) {
    if (!text) continue;
    const command = readSessionCommand(text);
    if (command) return command;
  }
  return null;
}
