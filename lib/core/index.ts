import { createNodeFs, NodeLockHooks, type NodeFileHandle } from './node.js'
import { Locker, type Fs } from './types.js'
import { createLocker } from './locking.js'

export {
  type Fs as Backend,
  type LockRange,
  type PollOptions,
  Lock,
  type FileDescriptor,
  type FileHandle,
  type Locker,
  type Fs,
} from './types.js'
export * from './locking.js'
export * from './guard.js'
export * from './node.js'

/** Lazily create and return the shared default Node.js filesystem singleton. */
let _defaultFs: Fs<NodeFileHandle> | undefined
export const defaultFs = () => {
  if (!_defaultFs) _defaultFs = createNodeFs()
  return _defaultFs
}

/** Lazily create and return the shared default native locker singleton. */
let _defaultLocking: Locker | undefined
export const defaultLocking = () => {
  if (!_defaultLocking) _defaultLocking = createLocker(new NodeLockHooks())
  return _defaultLocking
}
