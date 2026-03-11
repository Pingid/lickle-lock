import { it, describe, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'

import { exclusive, shared, tryExclusive, tryShared } from '../dist/esm/index.js'
import { spawnWorker, Util, type Exec, spawnChild } from './util/index.js'

const locksDir = path.join(import.meta.dirname, './locks')
const getPath = (name: string) => path.join(locksDir, name)
beforeAll(() => fs.promises.mkdir(locksDir, { recursive: true }).catch(() => {}))
afterAll(() => fs.promises.rm(locksDir, { recursive: true }).catch(() => {}))

describe('concurrency', () => {
  it('concurrent updates', async () => {
    const [file, count] = [getPath('counter-concurrent'), 20]
    await Promise.all(
      Array.from({ length: count }).map(async () => {
        await using guard = await exclusive(file)
        const value = await Util.readInt(guard.handle)
        await new Promise((r) => setTimeout(r, 1))
        await Util.writeInt(guard.handle, value + 1)
      }),
    )
    await using guard = await exclusive(file)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })

  const execIncrementConcurrent = async (file: string, count: number, exec: Exec) => {
    await Promise.all(
      Array.from({ length: count }).map(async () =>
        exec(
          async ({ exclusive, writeInt, readInt }, file) => {
            const guard = await exclusive(file)
            const value = await readInt(guard.handle)
            await new Promise((r) => setTimeout(r, 1))
            await writeInt(guard.handle, value + 1)
            await guard.drop()
          },
          [file],
        ),
      ),
    )
  }

  it('handles child process contention gracefully across libuv boundaries', async () => {
    const [file, count] = [getPath('process-contention'), 5]
    await execIncrementConcurrent(file, count, (f, args) => spawnChild().then(({ execOnce }) => execOnce(f, args)))
    await using guard = await exclusive(file)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })

  it('handles worker thread contention gracefully across libuv boundaries', async () => {
    const [file, count] = [getPath('worker-contention'), 5]
    await execIncrementConcurrent(file, count, (f, args) => spawnWorker().then(({ execOnce }) => execOnce(f, args)))
    await using guard = await exclusive(file)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })
})

describe('read/write concurrency', () => {
  it('allows multiple shared locks simultaneously but blocks exclusive', async () => {
    const file = getPath('shared-test')

    // Two readers grab the lock. This should not block.
    const reader1 = await shared(file)
    const reader2 = await shared(file)
    expect(reader1.dropped).toBe(false)
    expect(reader2.dropped).toBe(false)

    // A writer tries to grab the lock. It should be blocked.
    let writerAcquired = false
    const writerPromise = exclusive(file).then((guard) => {
      writerAcquired = true
      return guard
    })

    // Give the event loop a moment; the writer should still be waiting
    await new Promise((r) => setTimeout(r, 50))
    expect(writerAcquired).toBe(false)

    // Drop one reader. Writer should STILL be waiting.
    await reader1.drop()
    await new Promise((r) => setTimeout(r, 10))
    expect(writerAcquired).toBe(false)

    // Drop the final reader. Writer should instantly acquire.
    await reader2.drop()
    const writer = await writerPromise
    expect(writerAcquired).toBe(true)

    await writer.drop()
  })
})

describe('timeouts', () => {
  it('throws an error if the lock cannot be acquired within the timeout', async () => {
    const file = getPath('timeout-test')

    // Main process holds the lock
    const guard = await exclusive(file)

    const start = Date.now()

    // Attempt to grab it with a 100ms timeout
    const attempt = exclusive(file, { timeout: 100, pollMs: 20 })

    await expect(attempt).rejects.toThrow(/Timed out/)

    const duration = Date.now() - start
    expect(duration).toBeGreaterThanOrEqual(80) // Account for slight JS timer drift
    expect(duration).toBeLessThan(500)

    await guard.drop()
  })
})

describe('non-blocking tries (tryExclusive / tryShared)', () => {
  it('tryExclusive returns undefined immediately if locked, or a guard if free', async () => {
    const file = getPath('try-exclusive-test')

    // 1. Grab the lock normally
    const guard1 = await exclusive(file)
    expect(guard1.dropped).toBe(false)

    // 2. Try to grab it non-blocking. Should fail immediately and return undefined.
    const start = Date.now()
    const guard2 = await tryExclusive(file)
    const duration = Date.now() - start

    expect(guard2).toBeUndefined()
    expect(duration).toBeLessThan(50) // Should be instant

    // 3. Drop the first lock and try again. Should succeed.
    await guard1.drop()
    const guard3 = await tryExclusive(file)
    expect(guard3).toBeDefined()
    expect(guard3?.dropped).toBe(false)

    await guard3?.drop()
  })

  it('tryShared returns undefined if exclusive lock held, but succeeds if shared lock held', async () => {
    const file = getPath('try-shared-test')

    const exGuard = await exclusive(file)
    const sharedAttempt1 = await tryShared(file)
    expect(sharedAttempt1).toBeUndefined() // Exclusive blocks shared

    await exGuard.drop()

    const sharedGuard1 = await shared(file)
    const sharedAttempt2 = await tryShared(file)
    expect(sharedAttempt2).toBeDefined() // Shared allows other shared

    await sharedGuard1.drop()
    await sharedAttempt2?.drop()
  })
})

describe('FileGuard lifecycle & error handling', () => {
  it('prevents accessing the handle after dropping', async () => {
    const file = getPath('guard-access-test')
    const guard = await exclusive(file)

    expect(guard.handle).toBeDefined()
    await guard.drop()

    expect(guard.dropped).toBe(true)
    expect(() => guard.handle).toThrow('FileGuard has been dropped')
  })

  it('allows drop() to be called multiple times safely (idempotent)', async () => {
    const file = getPath('guard-drop-test')
    const guard = await exclusive(file)

    await expect(guard.drop()).resolves.toBeUndefined()
    // A second drop should resolve safely without throwing "bad file descriptor"
    await expect(guard.drop()).resolves.toBeUndefined()
  })

  it('cleans up correctly using Symbol.asyncDispose', async () => {
    const file = getPath('guard-dispose-test')

    {
      await using guard = await exclusive(file)
      expect(guard.dropped).toBe(false)
    } // Should drop here

    // We should be able to instantly grab the lock again
    const guard2 = await tryExclusive(file)
    expect(guard2).toBeDefined()
    await guard2?.drop()
  })
})

describe('exclusive vs shared interactions', () => {
  it('exclusive lock blocks incoming shared locks', async () => {
    const file = getPath('exclusive-blocks-shared')

    const writer = await exclusive(file)
    let readerAcquired = false

    const readerPromise = shared(file).then((guard) => {
      readerAcquired = true
      return guard
    })

    // Give event loop time to process the reader attempt
    await new Promise((r) => setTimeout(r, 50))
    expect(readerAcquired).toBe(false)

    // Releasing writer should unblock reader
    await writer.drop()
    const reader = await readerPromise
    expect(readerAcquired).toBe(true)

    await reader.drop()
  })
})

describe('signal handlers', () => {
  it('releases lock if child process is killed via SIGINT', async () => {
    const file = getPath('sigint-test')

    const child = await spawnChild()
    await child.exec(
      async ({ exclusive }, file) => {
        await exclusive(file)
        return 'locked'
      },
      [file],
    )
    child.kill('SIGINT')
    await child.exit

    const guard = await tryExclusive(file)
    expect(guard).toBeDefined()
    await guard?.drop()
  })

  it('releases lock if child process is killed via SIGTERM', async () => {
    const file = getPath('sigterm-test')

    const child = await spawnChild()
    await child.exec(
      async ({ exclusive }, file) => {
        await exclusive(file)
        return 'locked'
      },
      [file],
    )
    child.kill('SIGTERM')
    await child.exit

    const guard = await tryExclusive(file)
    expect(guard).toBeDefined()
    await guard?.drop()
  })
})
