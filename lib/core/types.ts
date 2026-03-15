/** Filesystem abstraction for opening lock files. */
export interface Fs<H extends FileHandle> {
  /** Open (or create) the lock file and return a handle. */
  open(file: string, type: Lock): Promise<H>
}

/** Lock/unlock operations, separated from file opening for composability. */
export interface Locker {
  /** Acquire a lock, polling until available or timeout is reached. */
  lock: (fd: FileDescriptor, type: Lock, range?: LockRange, options?: PollOptions) => Promise<void>
  /** Try to acquire a lock without waiting. Return true if acquired. */
  tryLock: (fd: FileDescriptor, type: Lock, range?: LockRange) => Promise<boolean>
  /** Release a previously acquired lock. */
  unlock: (fd: FileDescriptor, range?: LockRange) => Promise<void>
}

/** Lock mode: exclusive (write) or shared (read). */
export enum Lock {
  Exclusive,
  Shared,
}

/** Options for polling lock acquisition. */
export interface PollOptions {
  /** Polling interval in milliseconds. */
  pollMs?: number
  /** Maximum wait time in milliseconds. */
  timeout?: number
  /** Multiplier applied to pollMs after each failed attempt (e.g. 2 = exponential backoff). */
  backoff?: number
}

/** Byte range within a file to lock. Used for range-level locking. */
export interface LockRange {
  /** Starting byte offset. */
  offset: number
  /** Number of bytes to lock. */
  length: number
}

/** An open file handle with a descriptor and a close method. */
export interface FileHandle {
  /** The numeric file descriptor. */
  fd: number
  /** Close the file handle. */
  close: () => Promise<void>
}

/** File descriptor or file descriptor object. */
export type FileDescriptor = { fd: number } | number

/** @internal */
export const resolveFd = (fd: FileDescriptor): number => (typeof fd === 'number' ? fd : fd.fd)
