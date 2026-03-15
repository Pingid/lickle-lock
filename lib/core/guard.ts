import { type FileDescriptor, type FileHandle, type Locker, type LockRange, resolveFd } from './types.js'

/**
 * Guard that holds a lock without owning the file handle.
 * Releasing the guard unlocks the file but does not close it.
 *
 * @example
 * const guard = await lock(handle, Lock.Exclusive)
 * try { /* work *\/ } finally { await guard.drop() }
 */
export class LockGuard<H extends FileDescriptor> {
  private _dropped: Promise<void> | undefined
  /** The file descriptor number. */
  public readonly fd: number

  constructor(
    private locking: Locker,
    handle: H,
    private range?: LockRange,
  ) {
    this.fd = resolveFd(handle)
  }

  /** True if the lock has been released. */
  get dropped() {
    return !!this._dropped
  }

  /** Release the lock. Safe to call multiple times. */
  drop(): Promise<void> {
    if (!this._dropped) this._dropped = this.locking.unlock(this.fd, this.range)
    return this._dropped
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.drop()
  }
}

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
export class FileLockGuard<H extends FileHandle> {
  private _dropped: Promise<void> | undefined
  /** The file descriptor number. */
  public readonly fd: number

  constructor(
    private guard: LockGuard<H>,
    private hndl: H,
  ) {
    this.fd = hndl.fd
  }

  /** The underlying file handle. Throws if the guard has been dropped. */
  get handle(): H {
    if (this._dropped) throw new Error('FileGuard has been dropped')
    return this.hndl
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
          await this.guard.drop()
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
