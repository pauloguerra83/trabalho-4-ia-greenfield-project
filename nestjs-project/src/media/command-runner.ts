import { execFile } from 'child_process';

export const COMMAND_RUNNER = Symbol('COMMAND_RUNNER');

export interface CommandOptions {
  timeoutMs: number;
}

/** Runs a binary without a shell and resolves with its raw stdout. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<Buffer>;

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
    cause: unknown,
  ) {
    super(`${command} failed: ${stderr.trim() || String(cause)}`);
    this.name = 'CommandFailedError';
  }
}

/** Thumbnails come back on stdout, so allow a few MB of output. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const execFileRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'buffer',
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new CommandFailedError(command, stderr.toString(), error));
          return;
        }
        resolve(stdout);
      },
    );
  });
