import { type PollOptions, type LockRange, type FileDescriptor, type Locker, Lock, resolveFd } from './types.js'
import * as native from '#native'

/**
 * Lifecycle hooks called when locks are acquired and released.
 * Used by backends to track active locks for cleanup on exit or signals.
 */
export interface LockHooks {
  /** Called after a lock is successfully acquired. */
  register: (fd: FileDescriptor) => Promise<void>
  /** Called when a lock is released (even if unlock itself fails). */
  unregister: (fd: FileDescriptor) => Promise<void>
}

/**
 * Create a {@link Locker} backed by native OS locks.
 *
 * Whole-file locks use `flock(2)` on Unix and `LockFileEx` on Windows.
 * Range locks use `fcntl(2)` OFD locks on Linux, POSIX record locks on
 * macOS/BSD, and ranged `LockFileEx` on Windows.
 *
 * If `hooks` are provided they are called after lock acquisition and on
 * release, allowing backends to track active locks for cleanup.
 */
export const createLocker = (hooks?: LockHooks): Locker => ({
  async lock(fd: FileDescriptor, type: Lock, range?: LockRange, options?: PollOptions): Promise<void> {
    const d = resolveFd(fd)
    await native.lock(d, toNativeLock(type), range, options)
    try {
      await hooks?.register(d)
    } catch (err) {
      try {
        native.lockSync(d, native.Lock.Unlock, range)
      } catch {}
      throw err
    }
  },

  async tryLock(fd: FileDescriptor, type: Lock, range?: LockRange): Promise<boolean> {
    const d = resolveFd(fd)
    const locked = await native.tryLock(d, toNativeLock(type), range)
    if (!locked) return false
    try {
      await hooks?.register(d)
      return true
    } catch (err) {
      try {
        native.lockSync(d, native.Lock.Unlock, range)
      } catch {}
      throw err
    }
  },

  async unlock(fd: FileDescriptor, range?: LockRange): Promise<void> {
    const d = resolveFd(fd)
    try {
      native.lockSync(d, native.Lock.Unlock, range)
    } finally {
      await hooks?.unregister(d)
    }
  },
})

const toNativeLock = (type: Lock): native.Lock => (type === Lock.Exclusive ? native.Lock.Exclusive : native.Lock.Shared)
