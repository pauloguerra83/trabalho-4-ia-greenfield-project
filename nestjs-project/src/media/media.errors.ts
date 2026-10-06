/**
 * The input is not a usable video. Permanent: retrying cannot fix it, so
 * the video processor turns it into an unrecoverable job failure.
 */
export class InvalidMediaError extends Error {
  constructor(reason: string) {
    super(`Invalid media: ${reason}`);
    this.name = 'InvalidMediaError';
  }
}
