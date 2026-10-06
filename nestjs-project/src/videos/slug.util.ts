import { randomBytes } from 'crypto';

const SLUG_BYTES = 8;

/** 8 random bytes in base64url: an 11-character, non-enumerable slug. */
export function generateSlug(): string {
  return randomBytes(SLUG_BYTES).toString('base64url');
}
