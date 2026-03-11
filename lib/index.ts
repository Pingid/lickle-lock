import { type Backend, type FileHandle, type NodeFileHandle, FileGuard, defaultBackend } from './backend/index.js'
export * from './backend/index.js'

/**
 * Acquire an exclusive (write) lock on a file, polling until available.
 * Creates the file if it does not exist.
 *
 * @example
 * const guard = await exclusive('/tmp/my.lock')
 * try { /* critical section *\/ } finally { await guard.drop() }
 *
 * @example
 * await using guard = await exclusive('/tmp/my.lock', { timeout: 5000 })
 */
export const exclusive = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  options?: { backend?: Backend<H>; pollMs?: number; timeout?: number },
): Promise<FileGuard<H>> => acquireLock(file, 'exclusive', options)

/**
 * Try to acquire an exclusive lock without waiting.
 * Return undefined if the lock is already held.
 *
 * @example
 * const guard = await tryExclusive('/tmp/my.lock')
 * if (guard) { /* acquired *\/ }
 */
export const tryExclusive = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  options?: { backend?: Backend<H> },
): Promise<FileGuard<H> | undefined> => tryAcquireLock(file, 'exclusive', options)

/**
 * Acquire a shared (read) lock on a file, polling until available.
 * Multiple shared locks may be held concurrently.
 * Creates the file if it does not exist.
 *
 * @example
 * await using guard = await shared('/tmp/my.lock')
 */
export const shared = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  options?: { backend?: Backend<H>; pollMs?: number; timeout?: number },
): Promise<FileGuard<H>> => acquireLock(file, 'shared', options)

/**
 * Try to acquire a shared lock without waiting.
 * Return undefined if an exclusive lock is already held.
 *
 * @example
 * const guard = await tryShared('/tmp/my.lock')
 * if (guard) { /* acquired *\/ }
 */
export const tryShared = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  options?: { backend?: Backend<H> },
): Promise<FileGuard<H> | undefined> => tryAcquireLock(file, 'shared', options)

const acquireLock = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  mode: 'exclusive' | 'shared',
  options?: { backend?: Backend<H>; pollMs?: number; timeout?: number },
): Promise<FileGuard<H>> => {
  const { backend = defaultBackend() as unknown as Backend<H> } = options ?? {}
  const handle = await backend.open(file)
  try {
    await backend.lock(handle, mode, options)
    return new FileGuard<H>(backend, handle)
  } catch (error) {
    await handle.close()
    throw error
  }
}

const tryAcquireLock = async <H extends FileHandle = NodeFileHandle>(
  file: string,
  mode: 'exclusive' | 'shared',
  options?: { backend?: Backend<H> },
): Promise<FileGuard<H> | undefined> => {
  const { backend = defaultBackend() as unknown as Backend<H> } = options ?? {}
  const handle = await backend.open(file)
  try {
    const result = await backend.tryLock(handle, mode)
    if (result) return new FileGuard<H>(backend, handle)
    await handle.close()
    return undefined
  } catch (error) {
    await handle.close()
    throw error
  }
}
