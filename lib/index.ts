import {
  type NodeFileHandle,
  type LockRange,
  type PollOptions,
  type Lock,
  type FileHandle,
  type FileDescriptor,
  type Fs,
  type Locker,
  FileLockGuard,
  LockGuard,
  defaultFs,
  defaultLocking,
} from './core/index.js'
export * from './core/index.js'

/** Options for specifying a custom locker and/or byte range. */
export interface LockingOptions {
  /** Custom locker implementation. Uses the default native locker if omitted. */
  locking?: Locker
  /** Byte range to lock. Locks the entire file if omitted. */
  range?: LockRange
}

/**
 * Acquire a lock on an already-open file handle.
 *
 * @example
 * import fs from 'node:fs/promises'
 * const handle = await fs.open('/tmp/my.lock', 'r+')
 * await using guard = await lock(handle, Lock.Exclusive)
 */
export const lock = async <H extends FileHandle = NodeFileHandle>(
  handle: H,
  type: Lock,
  options?: LockingOptions & PollOptions,
): Promise<LockGuard<H>> => {
  const { locking = defaultLocking() } = options ?? {}
  await locking.lock(handle, type, options?.range, options)
  return new LockGuard<H>(locking, handle, options?.range)
}

/**
 * Try to acquire a lock on an already-open file handle without waiting.
 *
 * @example
 * import fs from 'node:fs/promises'
 * const handle = await fs.open('/tmp/my.lock', 'r+')
 * const guard = await tryLock(handle, Lock.Exclusive)
 * if (guard) { /* acquired *\/ }
 */
export const tryLock = async <H extends FileDescriptor>(
  handle: H,
  type: Lock,
  options?: LockingOptions & PollOptions,
): Promise<LockGuard<H> | undefined> => {
  const { locking = defaultLocking() } = options ?? {}
  const result = await locking.tryLock(handle, type, options?.range)
  if (result) return new LockGuard<H>(locking, handle, options?.range)
  return undefined
}

/**
 * Release a lock on a file descriptor or file handle.
 *
 * @example
 * import fs from 'node:fs/promises'
 * const handle = await fs.open('/tmp/my.lock', 'r+')
 * await lock(handle, Lock.Exclusive)
 * // ... critical section ...
 * await unlock(handle)
 */
export const unlock = async <H extends FileDescriptor>(handle: H, options?: LockingOptions): Promise<void> => {
  const { locking = defaultLocking() } = options ?? {}
  await locking.unlock(handle, options?.range)
}

/** Options for open-and-lock functions that manage the file lifecycle. */
export interface OpenLockOptions<H extends FileHandle> extends LockingOptions {
  /** Custom filesystem for opening files. Uses the default Node.js fs if omitted. */
  fs?: Fs<H>
}

/**
 * Open a file and acquire a lock, polling until available. Closes the file on failure.
 *
 * @example
 * await using guard = await openLock('/tmp/my.lock', Lock.Exclusive)
 *
 * @example
 * await using guard = await openLock('/tmp/my.lock', Lock.Shared, { timeout: 5000 })
 */
export const openLock = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  type: Lock,
  options?: OpenLockOptions<H> & PollOptions,
): Promise<FileLockGuard<H>> => {
  const { fs = defaultFs() as unknown as Fs<H> } = options ?? {}
  const handle = await fs.open(file, type)
  try {
    return new FileLockGuard<H>(await lock(handle, type, options), handle)
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Open a file and try to acquire a lock without waiting. Closes the file if not acquired.
 *
 * @example
 * const guard = await tryOpenLock('/tmp/my.lock', Lock.Exclusive)
 * if (guard) { /* acquired *\/ }
 */
export const tryOpenLock = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  type: Lock,
  options?: OpenLockOptions<H>,
): Promise<FileLockGuard<H> | undefined> => {
  const { fs = defaultFs() as unknown as Fs<H> } = options ?? {}
  const handle = await fs.open(file, type)
  try {
    const result = await tryLock(handle, type, options)
    if (result) return new FileLockGuard<H>(result, handle)
    await handle.close()
    return undefined
  } catch (error) {
    await handle.close()
    throw error
  }
}
