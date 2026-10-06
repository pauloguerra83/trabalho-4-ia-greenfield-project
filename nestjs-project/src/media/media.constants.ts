export const MEDIA_TIMEOUTS_MS = {
  PROBE: 60_000,
  THUMBNAIL: 120_000,
} as const;

export const THUMBNAIL = {
  WIDTH: 1280,
  /** Share of the duration where the frame is taken. */
  POSITION_RATIO: 0.1,
  /** Keeps the seek point strictly before the end of short clips. */
  END_MARGIN_SECONDS: 0.1,
} as const;

/**
 * ffprobe/ffmpeg messages meaning the input itself is unreadable as video,
 * as opposed to transient failures (network, storage, timeouts).
 */
export const INVALID_INPUT_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
];
