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
  private _active = new Set<number>()
  private _handlingSignal = false

  private _finalizer = new FinalizationRegistry<{ fd: number; path: string }>((held) => {
    try {
      fs.closeSync(held.fd)
    } catch {
      // EBADF (Bad file descriptor) is expected if the user or Node already closed it
    }
  })

  async register(handle: FileHandle): Promise<void> {
    if (this._active.size === 0) this._listen()
    this._active.add(handle.fd)
    this._finalizer.register(handle, { fd: handle.fd, path: handle.path }, handle)
  }

  async unregister(handle: FileHandle): Promise<void> {
    this._finalizer.unregister(handle)
    this._active.delete(handle.fd)
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
    for (const fd of Array.from(this._active.values()).reverse()) {
      try {
        fs.closeSync(fd)
      } catch {
        // EBADF (Bad file descriptor) is expected if the user or Node already closed it
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
