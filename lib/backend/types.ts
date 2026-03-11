/**
 * Backend for file operations.
 *
 * @example Customize file open:
 * ```ts
 * import { createLockable } from '@lickle/lock'
 * const backend = {
 *   open: async (file: string) => your open logic,
 *   ...createLockable(),
 * }
 * ```
 */
export interface Backend<H extends FileHandle> extends Lockable<H> {
  /** Open (or create) the lock file and return a handle. */
  open(file: string): Promise<H>
}

/** Lock/unlock operations, separated from file opening for composability. */
export interface Lockable<H extends FileHandle> {
  /** Acquire a lock, polling until available or timeout is reached. */
  lock: (handle: H, mode: 'exclusive' | 'shared', options?: { pollMs?: number; timeout?: number }) => Promise<void>
  /** Try to acquire a lock without waiting. Return true if acquired. */
  tryLock: (handle: H, mode: 'exclusive' | 'shared') => Promise<boolean>
  /** Release a previously acquired lock. */
  unlock: (handle: H) => Promise<void>
}

/** Represents an open file descriptor with its path. */
export interface FileHandle {
  readonly fd: number
  readonly path: string
  close(): Promise<void>
  handle: any
}
