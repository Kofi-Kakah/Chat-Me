/**
 * Usernames are constrained by USERNAME_REGEX in modules/auth/auth.schemas.ts to
 * 3-24 characters of `a-z`, `0-9`, `_` or `.`. The same alphabet is used here so
 * a mention can only ever match something that could be a real username.
 *
 * The first and last characters are deliberately restricted to `a-z0-9_`: a
 * permissive trailing class would capture the full stop in "@alice." and look up
 * a user called `alice.` instead of `alice`.
 */
const MENTION_PATTERN = /@([a-z0-9_][a-z0-9_.]{1,22}[a-z0-9_])/gi;

/** Extracts the unique, lower-cased usernames mentioned in a message body. */
export function extractMentionedUsernames(body: string | null | undefined): Set<string> {
  if (!body) return new Set();

  const usernames = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    usernames.add(match[1].toLowerCase());
  }
  return usernames;
}
