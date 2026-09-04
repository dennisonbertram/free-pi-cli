// pi prints its own resume hint immediately before process.exit(0) when an
// interactive session ends:
//
//   To resume this session: pi --session <id>
//
// That names `pi`, a binary free-pi-cli users do not have — they installed
// free-pi-cli (usually via npx). pi builds the command from APP_NAME, which
// only a rebranded *pi* package.json (piConfig.name) can change, and the line
// is written straight to stdout with no env-var escape hatch. It also exits
// the process immediately after, so run.ts's own correctly-branded closing
// line can be cut off before it prints.
//
// So we rewrite that one line on its way to the terminal, and leave every
// other byte untouched.

/** The literal prefix pi writes (chalk.dim wraps it, so match on the text, not the bytes). */
const RESUME_LABEL = "To resume this session:";

/**
 * The label, then any mix of ANSI escapes and whitespace (chalk closes its
 * dim styling with `[22m` between the label and the command), then the
 * `pi` command word — bounded by whitespace so a later "pi" in prose is never
 * touched.
 */
const RESUME_COMMAND_RE = /(To resume this session:(?:\u001b\[[0-9;]*m|\s)*)pi(?=\s)/g;

/**
 * Rewrites pi's `pi --session <id>` resume command into free-pi-cli's
 * equivalent. Only the command word is replaced; pi's own flags (including
 * `--session-dir <path>` when a non-default session dir is in play) are
 * preserved exactly, so the printed command stays correct.
 *
 * Returns the chunk unchanged when it carries no resume line, which is the
 * overwhelmingly common case (every other write passes through untouched).
 */
export function rewriteResumeLine(chunk: string): string {
  if (!chunk.includes(RESUME_LABEL)) return chunk;
  return chunk.replace(RESUME_COMMAND_RE, "$1npx free-pi-cli");
}

/** Minimal structural slice of the stream this patches — keeps it testable without a real TTY. */
export interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

/**
 * Wraps `stream.write` so pi's resume line is rebranded on the way out.
 * Non-string chunks (Buffers) and every chunk without the resume label pass
 * straight through to the original write, so this cannot alter the TUI's own
 * byte stream. Returns a function that restores the original write.
 */
export function patchResumeLine(stream: WritableLike): () => void {
  const original = stream.write.bind(stream);
  stream.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return original(chunk, ...rest);
    return original(rewriteResumeLine(chunk), ...rest);
  };
  return () => {
    stream.write = original;
  };
}
