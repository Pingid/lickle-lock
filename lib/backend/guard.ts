import type { Backend, FileHandle, LockRange } from './index.js'

/**
 * RAII guard that holds a file lock. Unlocks and closes the file on drop.
 * Supports `await using` via `Symbol.asyncDispose`.
 *
 * @example
 * await using guard = await exclusive('/tmp/my.lock')
 * // lock is released when guard goes out of scope
 *
 * @example
 * const guard = await exclusive('/tmp/my.lock')
 * try { /* work *\/ } finally { await guard.drop() }
 */
export class FileGuard<H extends FileHandle> {
  private _dropped: Promise<void> | undefined
  /** The lock file path. */
  public readonly path: string
  /** The file descriptor number. */
  public readonly fd: number

  constructor(
    private backend: Backend<H>,
    private hndl: H,
    private range?: LockRange,
  ) {
    this.path = hndl.path
    this.fd = hndl.fd
  }

  /** The underlying file handle. Throws if the guard has been dropped. */
  get handle(): H['handle'] {
    if (this._dropped) throw new Error('FileGuard has been dropped')
    return this.hndl.handle
  }

  /** True if the lock has been released. */
  get dropped() {
    return !!this._dropped
  }

  /** Release the lock and close the file. Safe to call multiple times. */
  drop(): Promise<void> {
    if (!this._dropped) {
      this._dropped = (async () => {
        try {
          await this.backend.unlock(this.hndl, this.range)
        } finally {
          await this.hndl.close()
        }
      })()
    }
    return this._dropped
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.drop()
  }
}
