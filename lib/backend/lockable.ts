import type { FileHandle, Lockable } from '../index.js'

import * as native from '#native'

/** Lifecycle hooks called when locks are acquired and released. */
export interface LockHooks<H extends FileHandle> {
  register: (handle: H) => Promise<void>
  unregister: (handle: H) => Promise<void>
}

/**
 * Create a `Lockable` using native OS lock bindings (flock on Unix, LockFileEx on Windows).
 * Optional hooks are notified on lock/unlock for cleanup tracking.
 *
 * @example
 * const lockable = createLockable(myHooks)
 */
export const createLockable = <H extends FileHandle>(hooks?: LockHooks<H>): Lockable<H> => {
  const lock = (handle: H, mode: 'exclusive' | 'shared', options?: native.PollFlockOptions): Promise<void> => {
    if (mode === 'exclusive') return native.exclusive(handle.fd, options)
    else return native.shared(handle.fd, options)
  }

  const tryLock = (handle: H, mode: 'exclusive' | 'shared'): Promise<boolean> => {
    if (mode === 'exclusive') return native.tryExclusive(handle.fd)
    else return native.tryShared(handle.fd)
  }

  return {
    async lock(handle: H, mode: 'exclusive' | 'shared', options?: native.PollFlockOptions): Promise<void> {
      await lock(handle, mode, options)
      await hooks?.register(handle)
    },
    async tryLock(handle: H, mode: 'exclusive' | 'shared'): Promise<boolean> {
      const locked = await tryLock(handle, mode)
      if (locked) await hooks?.register(handle)
      return locked
    },
    async unlock(handle: H): Promise<void> {
      await hooks?.unregister(handle)
      await native.unlock(handle.fd)
    },
  }
}
