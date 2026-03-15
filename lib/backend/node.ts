import { isMainThread, parentPort } from 'node:worker_threads'
import fs from 'node:fs'

import { type LockHooks, createLockable } from './lockable.js'
import type { Backend, FileHandle } from './types.js'

/**
 * Create the default Node.js backend using native OS locks (flock on Unix, LockFileEx on Windows).
 * Registers cleanup hooks for process exit, signals, and GC.
 *
 * @example
 * const backend = createNodeBackend()
 * await exclusive('/tmp/my.lock', { backend })
 */
export const createNodeBackend = (): Backend<NodeFileHandle> => {
  const hooks = new NodeLockHooks()

  return {
    async open(file: string): Promise<NodeFileHandle> {
      const handle = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_RDWR)
      return new NodeFileHandle(handle, file)
    },
    ...createLockable(hooks),
  }
}

/** Wraps a Node.js `fs.promises.FileHandle` to satisfy the `FileHandle` interface. */
export class NodeFileHandle implements FileHandle {
  constructor(
    readonly handle: fs.promises.FileHandle,
    readonly path: string,
  ) {}

  get fd() {
    return this.handle.fd
  }

  close() {
    return this.handle.close()
  }
}

/**
 * Track active locks and ensure they are released on process exit,
 * SIGINT, SIGTERM, and GC finalization.
 */
export class NodeLockHooks implements LockHooks<FileHandle> {
  private _active = new Map<number, number>()
  private _tokens = new WeakMap<FileHandle, symbol>()
  private _handlingSignal = false

  private _finalizer = new FinalizationRegistry<{ fd: number }>((held) => {
    // Best-effort cleanup: closing the fd implicitly releases any held OS locks.
    // This is only a fallback for leaked handles/guards.
    try {
      fs.closeSync(held.fd)
    } catch {
      // EBADF is fine here: fd may already be closed/reused.
    }
  })

  async register(handle: FileHandle): Promise<void> {
    if (this._active.size === 0) this._listen()

    const fd = handle.fd
    this._active.set(fd, (this._active.get(fd) ?? 0) + 1)

    const token = Symbol(`lock:${handle.path}:${fd}`)
    this._tokens.set(handle, token)
    this._finalizer.register(handle, { fd }, token)
  }

  async unregister(handle: FileHandle): Promise<void> {
    const token = this._tokens.get(handle)
    if (token) {
      this._finalizer.unregister(token)
    }

    const fd = handle.fd
    const count = this._active.get(fd)
    if (count !== undefined) {
      if (count <= 1) this._active.delete(fd)
      else this._active.set(fd, count - 1)
    }

    if (this._active.size === 0) this._unlisten()
  }

  private _listen(): void {
    if (isMainThread) {
      process.on('exit', this._onExit)
      process.on('SIGINT', this._onSignal)
      process.on('SIGTERM', this._onSignal)
    } else {
      parentPort?.on('close', this._onExit)
    }
  }

  private _unlisten(): void {
    if (isMainThread) {
      process.off('exit', this._onExit)
      process.off('SIGINT', this._onSignal)
      process.off('SIGTERM', this._onSignal)
    } else {
      parentPort?.off('close', this._onExit)
    }
  }

  private _onExit = (): void => {
    for (const fd of Array.from(this._active.keys()).reverse()) {
      try {
        fs.closeSync(fd)
      } catch {
        // EBADF expected if already closed
      }
    }
    this._active.clear()
  }

  private _onSignal = (signal: string): void => {
    if (this._handlingSignal) return
    this._handlingSignal = true

    this._unlisten()
    this._onExit()

    try {
      process.kill(process.pid, signal)
    } catch {
      process.exit(1)
    }
  }
}
