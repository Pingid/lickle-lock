import { Worker } from 'node:worker_threads'
import type EventEmitter from 'node:events'
import { fork } from 'node:child_process'

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
  async (f, args) =>
    new Promise<any>((resolve, reject) => {
      child.once('message', (msg: any) => {
        if (msg.ok) resolve(msg.result)
        else reject(msg.error)
      })
      child.once('exit', reject)
      child.once('error', reject)
      send({ code: f.toString(), args })
    })
