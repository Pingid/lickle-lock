import { isMainThread, parentPort } from 'node:worker_threads'
import fs from 'node:fs'

import { type Fs, Lock, FileDescriptor, resolveFd } from './types.js'
import { type LockHooks } from './locking.js'

/** Node.js file handle type alias. */
export type NodeFileHandle = fs.promises.FileHandle

/** Create a Node.js filesystem that opens files with appropriate flags for the lock type. */
export const createNodeFs = (): Fs<NodeFileHandle> => {
  return {
    async open(file: string, type: Lock): Promise<NodeFileHandle> {
      const flags = type === Lock.Exclusive ? fs.constants.O_CREAT | fs.constants.O_RDWR : fs.constants.O_RDONLY
      const handle = await fs.promises.open(file, flags)
      return handle
    },
  }
}

/**
 * Track active locks by file descriptor and ensure they are released on process exit.
 */
export class NodeLockHooks implements LockHooks {
  private _active = new Map<number, number>()

  async register(fd: FileDescriptor): Promise<void> {
    if (this._active.size === 0) this._listen()
    const d = resolveFd(fd)
    this._active.set(d, (this._active.get(d) ?? 0) + 1)
  }

  async unregister(fd: FileDescriptor): Promise<void> {
    const d = resolveFd(fd)
    const count = this._active.get(d)
    if (count !== undefined) {
      if (count <= 1) this._active.delete(d)
      else this._active.set(d, count - 1)
    }

    if (this._active.size === 0) this._unlisten()
  }

  private _listen(): void {
    if (isMainThread) process.on('exit', this._onExit)
    else parentPort?.on('close', this._onExit)
  }

  private _unlisten(): void {
    if (isMainThread) process.off('exit', this._onExit)
    else parentPort?.off('close', this._onExit)
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
}
