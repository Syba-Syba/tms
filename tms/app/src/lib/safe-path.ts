/**
 * The sign-in guard remembers where you were headed and returns you there afterwards. That
 * target comes out of the address bar, so it is attacker controlled: a link to
 * `https://tms.example/\/evil.example` leaves `//evil.example` in the remembered path, and
 * following it after sign-in hands a freshly authenticated tenant to another site. It is the
 * classic post-login open redirect, and the shape phishing uses.
 *
 * React Router 6 has an advisory for the backslash form of this (GHSA-wrjc-x8rr-h8h6, fixed
 * only in 7.18) but a redirect target read from a URL should never have been trusted to the
 * router in the first place. Validating it here holds on every version.
 */
export function safeReturnPath(candidate: unknown, fallback = '/'): string {
  if (typeof candidate !== 'string' || candidate === '') return fallback;

  // Browsers treat a backslash as a path separator, so `/\evil` and `//evil` both leave the
  // origin. Normalising first means one rule catches both spellings.
  const path = candidate.replace(/\\/g, '/');

  // Exactly one leading slash: a relative path on this origin, never a protocol-relative URL.
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;

  // A control character (stray newline, tab or NUL) can smuggle a scheme past the check above.
  for (const character of path) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return fallback;
  }

  return path;
}
