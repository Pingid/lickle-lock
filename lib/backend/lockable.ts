import type { FileHandle, LockRange, Lockable, BlockingOptions, NonBlockingOptions } from '../index.js'

import * as native from '#native'

/** Lifecycle hooks called when locks are acquired and released. */
export interface LockHooks<H extends FileHandle> {
  register: (handle: H) => Promise<void>
  unregister: (handle: H) => Promise<void>
}

/**
 * Create a `Lockable` using native OS lock bindings (flock on Unix, LockFileEx on Windows).
 * When a range is specified, uses fcntl OFD locks (Unix) or ranged LockFileEx (Windows).
 * Optional hooks are notified on lock/unlock for cleanup tracking.
 *
 * @example
 * const lockable = createLockable(myHooks)
 */
export const createLockable = <H extends FileHandle>(hooks?: LockHooks<H>): Lockable<H> => ({
  async lock(handle: H, mode: 'exclusive' | 'shared', options?: BlockingOptions): Promise<void> {
    if (mode === 'exclusive') await native.lock(handle.fd, native.Lock.Exclusive, options?.range, options)
    else await native.lock(handle.fd, native.Lock.Shared, options?.range, options)

    try {
      await hooks?.register(handle)
    } catch (err) {
      try {
        native.lockSync(handle.fd, native.Lock.Unlock, options?.range)
      } catch {}
      throw err
    }
  },

  async tryLock(handle: H, mode: 'exclusive' | 'shared', options?: NonBlockingOptions): Promise<boolean> {
    const locked = await native.tryLock(
      handle.fd,
      mode === 'exclusive' ? native.Lock.Exclusive : native.Lock.Shared,
      options?.range,
    )
    if (!locked) return false

    try {
      await hooks?.register(handle)
      return true
    } catch (err) {
      try {
        native.lockSync(handle.fd, native.Lock.Unlock, options?.range)
      } catch {}
      throw err
    }
  },

  async unlock(handle: H, range?: LockRange): Promise<void> {
    try {
      native.lockSync(handle.fd, native.Lock.Unlock, range)
    } finally {
      await hooks?.unregister(handle)
    }
  },
})
