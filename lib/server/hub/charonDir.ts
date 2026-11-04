import { shQuote } from './sshExec';

// `<cwd>/.charon/` — the ONE folder Charon writes into a session's workspace
// (attachments, fork handoff transcripts), so a repo gets a single dotted
// directory instead of loose `.charon-*` entries at its root.
// ─────────────────────────────────────────────────────────────────────────────
// Git rule: Charon excludes `.charon/` only when IT CREATED the folder. A
// folder that already existed unignored is the user's call (they may track
// it), so nothing is added then.
//   - a `.gitignore` in the cwd, else at the repo toplevel, gets `.charon/`
//     (unanchored: covers a cwd below the toplevel too);
//   - no `.gitignore` at all: the repo's `info/exclude` (local, never
//     committed) — a fresh folder still never shows up as untracked;
//   - already ignored by any rule (global excludes included): untouched.
// Best-effort: no repo, no git or a read-only file never fails the caller.

export const CHARON_DIRNAME = '.charon';
export const CHARON_UPLOADS_DIR = `${CHARON_DIRNAME}/uploads`;
export const CHARON_FORK_DIR = `${CHARON_DIRNAME}/fork`;

/**
 * Shell creating `<cwd>/<sub>` (a path under `.charon/`) and, when this very
 * call created `.charon/`, keeping it out of git. Chainable with `&&`: exits 0
 * iff the directory exists afterwards. `mkdir` without `-p` is the atomic
 * "I created it" test, so concurrent uploads append the rule once.
 */
export function charonDirCommand(cwd: string, sub: string): string {
  const q = shQuote(cwd);
  const ignore = [
    `cd ${q} || exit 0`,
    `git check-ignore -q ${CHARON_DIRNAME} && exit 0`,
    `g=.gitignore`,
    `[ -f "$g" ] || { t=$(git rev-parse --show-toplevel) && [ -f "$t/.gitignore" ] && g="$t/.gitignore"; }`,
    `if [ -f "$g" ]; then`,
    `  grep -qxE '/?\\${CHARON_DIRNAME}/?' "$g" && exit 0`,
    // Never glue the rule onto a last line that lacks its newline.
    `  [ -s "$g" ] && [ -n "$(tail -c1 "$g")" ] && printf '\\n' >> "$g"`,
    `  printf '%s\\n' '${CHARON_DIRNAME}/' >> "$g"`,
    `else`,
    `  p=$(git rev-parse --show-prefix) && x=$(git rev-parse --git-path info/exclude) || exit 0`,
    `  l="/$p${CHARON_DIRNAME}/"`,
    `  grep -qxF "$l" "$x" || { mkdir -p "$(dirname "$x")" && printf '%s\\n' "$l" >> "$x"; }`,
    `fi`,
  ].join('\n');
  return `{ n=0; mkdir ${shQuote(`${cwd}/${CHARON_DIRNAME}`)} 2>/dev/null && n=1;`
    + ` mkdir -p ${shQuote(`${cwd}/${sub}`)} && { [ $n = 0 ] || (\n${ignore}\n) 2>/dev/null || true; }; }`;
}
