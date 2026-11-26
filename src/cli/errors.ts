export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Bad invocation or configuration, as opposed to a failed check. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
