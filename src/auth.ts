// Auth: the one bearer token and the login it names.
//
// The suite presents `Authorization: Bearer <token>` where the token is the
// process's MAKEFUN_SHOP_TOKEN. The login the token names is the scenario's
// viewer, "adaiversen" — the seeded scenario (kit wire.ts, SCENARIO_SEED) is
// fixed for every trial, so the viewer login is a fixed value, not something
// the token encodes. A repository belongs to that login: the same name under
// any other owner is a 404, never a 403.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_AVATAR = 'https://example.invalid/adaiversen.png';

/** The token the process expects, or null when none is configured (local dev: any non-empty token). */
export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

/** True when the request carries the expected bearer token. */
export function isAuthenticated(authorization: string | string[] | undefined): boolean {
  if (typeof authorization !== 'string') return false;
  if (!authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = expectedToken();
  return expected === null ? true : token === expected;
}
