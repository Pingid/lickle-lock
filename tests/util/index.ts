import { Worker } from 'node:worker_threads'
import type EventEmitter from 'node:events'
import { fork } from 'node:child_process'
import crypto from 'node:crypto'

import type * as Lock from '../../dist/esm/index.js'
import * as Util from './util.js'

export { Util }

type Context = typeof Lock & typeof Util

export const spawnWorker = async () => {
  const worker = new Worker(new URL('./worker.js', import.meta.url))
  const exit = new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve())
    worker.once('error', reject)
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('online', () => resolve())
    worker.once('error', reject)
    worker.once('exit', reject)
  })

  const exec = createExec(worker, worker.postMessage.bind(worker))

  const execOnce: Exec = async (f, args) => {
    const result = await exec(f, args)
    worker.terminate()
    await exit
    return result as any
  }

  return { exec, exit, execOnce }
}

export const spawnChild = async () => {
  const child = fork(new URL('./child.js', import.meta.url), {
    stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
  })

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
    child.once('exit', reject)
  })

  const exit = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })

  const exec = createExec(child, child.send.bind(child))

  const execOnce: Exec = async (f, args) => {
    const result = await exec(f, args)
    child.kill()
    await exit
    return result as any
  }

  const kill = (signal?: NodeJS.Signals | number) => child.kill(signal)

  return { exec, exit, kill, execOnce }
}

export type Exec = <A extends any[], R>(f: (ctx: Context, ...args: A) => R, args: A) => Promise<Awaited<R>>

const createExec =
  (child: EventEmitter, send: (message: any) => void): Exec =>
  (f, args) =>
    new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID()

      const onMessage = (msg: any) => {
        // Ignore messages not belonging to this invocation (e.g. debug output).
        if (msg?.id !== id) return
        cleanup()
        if (msg.ok) resolve(msg.result)
        else reject(Object.assign(new Error(msg.error.message), msg.error))
      }

      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`Child exited with code ${code ?? 'null'} before responding to exec id ${id}`))
      }

      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }

      const cleanup = () => {
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('error', onError)
      }

      child.on('message', onMessage)
      child.once('exit', onExit)
      child.once('error', onError)

      send({ id, code: f.toString(), args })
    })
