import { it, describe, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'

import { openLock, tryOpenLock, createLocker, Lock } from '../dist/esm/index.js'
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
        await using guard = await openLock(file, Lock.Exclusive)
        const value = await Util.readInt(guard.handle)
        await new Promise((r) => setTimeout(r, 1))
        await Util.writeInt(guard.handle, value + 1)
      }),
    )
    await using guard = await openLock(file, Lock.Exclusive)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })

  const execIncrementConcurrent = async (file: string, count: number, exec: Exec) => {
    await Promise.all(
      Array.from({ length: count }).map(async () =>
        exec(
          async ({ openLock, Lock, writeInt, readInt }, file) => {
            const guard = await openLock(file, Lock.Exclusive)
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
    await using guard = await openLock(file, Lock.Exclusive)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })

  it('handles worker thread contention gracefully across libuv boundaries', async () => {
    const [file, count] = [getPath('worker-contention'), 5]
    await execIncrementConcurrent(file, count, (f, args) => spawnWorker().then(({ execOnce }) => execOnce(f, args)))
    await using guard = await openLock(file, Lock.Exclusive)
    const current = await Util.readInt(guard.handle)
    expect(current).toBe(count)
  })
})

describe('read/write concurrency', () => {
  it('allows multiple shared locks simultaneously but blocks exclusive', async () => {
    const file = getPath('shared-test')
    await fs.promises.writeFile(file, Buffer.alloc(1024))

    // Two readers grab the lock. This should not block.
    const reader1 = await openLock(file, Lock.Shared)
    const reader2 = await openLock(file, Lock.Shared)
    expect(reader1.dropped).toBe(false)
    expect(reader2.dropped).toBe(false)

    // A writer tries to grab the lock. It should be blocked.
    let writerAcquired = false
    const writerPromise = openLock(file, Lock.Exclusive).then((guard) => {
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
    const guard = await openLock(file, Lock.Exclusive)

    const start = Date.now()

    // Attempt to grab it with a 100ms timeout
    const attempt = openLock(file, Lock.Exclusive, { timeout: 100, pollMs: 20 })

    await expect(attempt).rejects.toThrow(/Timed out/)

    const duration = Date.now() - start
    expect(duration).toBeGreaterThanOrEqual(80) // Account for slight JS timer drift
    expect(duration).toBeLessThan(500)

    await guard.drop()
  })
})

describe('non-blocking tries (tryOpenLock)', () => {
  it('tryOpenLock returns undefined immediately if locked, or a guard if free', async () => {
    const file = getPath('try-exclusive-test')

    // 1. Grab the lock normally
    const guard1 = await openLock(file, Lock.Exclusive)
    expect(guard1.dropped).toBe(false)

    // 2. Try to grab it non-blocking. Should fail immediately and return undefined.
    const start = Date.now()
    const guard2 = await tryOpenLock(file, Lock.Exclusive)
    const duration = Date.now() - start

    expect(guard2).toBeUndefined()
    expect(duration).toBeLessThan(50) // Should be instant

    // 3. Drop the first lock and try again. Should succeed.
    await guard1.drop()
    const guard3 = await tryOpenLock(file, Lock.Exclusive)
    expect(guard3).toBeDefined()
    expect(guard3?.dropped).toBe(false)

    await guard3?.drop()
  })

  it('tryOpenLock shared returns undefined if exclusive lock held, but succeeds if shared lock held', async () => {
    const file = getPath('try-shared-test')

    const exGuard = await openLock(file, Lock.Exclusive)
    const sharedAttempt1 = await tryOpenLock(file, Lock.Shared)
    expect(sharedAttempt1).toBeUndefined() // Exclusive blocks shared

    await exGuard.drop()

    const sharedGuard1 = await openLock(file, Lock.Shared)
    const sharedAttempt2 = await tryOpenLock(file, Lock.Shared)
    expect(sharedAttempt2).toBeDefined() // Shared allows other shared

    await sharedGuard1.drop()
    await sharedAttempt2?.drop()
  })
})

describe('FileLockGuard lifecycle & error handling', () => {
  it('prevents accessing the handle after dropping', async () => {
    const file = getPath('guard-access-test')
    const guard = await openLock(file, Lock.Exclusive)

    expect(guard.handle).toBeDefined()
    await guard.drop()

    expect(guard.dropped).toBe(true)
    expect(() => guard.handle).toThrow('FileGuard has been dropped')
  })

  it('allows drop() to be called multiple times safely (idempotent)', async () => {
    const file = getPath('guard-drop-test')
    const guard = await openLock(file, Lock.Exclusive)

    await expect(guard.drop()).resolves.toBeUndefined()
    // A second drop should resolve safely without throwing "bad file descriptor"
    await expect(guard.drop()).resolves.toBeUndefined()
  })

  it('cleans up correctly using Symbol.asyncDispose', async () => {
    const file = getPath('guard-dispose-test')

    {
      await using guard = await openLock(file, Lock.Exclusive)
      expect(guard.dropped).toBe(false)
    } // Should drop here

    // We should be able to instantly grab the lock again
    const guard2 = await tryOpenLock(file, Lock.Exclusive)
    expect(guard2).toBeDefined()
    await guard2?.drop()
  })
})

describe('exclusive vs shared interactions', () => {
  it('exclusive lock blocks incoming shared locks', async () => {
    const file = getPath('exclusive-blocks-shared')

    const writer = await openLock(file, Lock.Exclusive)
    let readerAcquired = false

    const readerPromise = openLock(file, Lock.Shared).then((guard) => {
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

describe('range locks', () => {
  it('non-overlapping ranges do not conflict', async () => {
    const file = getPath('range-no-conflict')

    const guard1 = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
    const guard2 = await tryOpenLock(file, Lock.Exclusive, { range: { offset: 10, length: 10 } })

    expect(guard2).toBeDefined()

    await guard1.drop()
    await guard2?.drop()
  })

  it('shared range locks allow concurrent readers on the same range', async () => {
    const file = getPath('range-shared')
    await fs.promises.writeFile(file, Buffer.alloc(1024))

    const reader1 = await openLock(file, Lock.Shared, { range: { offset: 0, length: 100 } })
    const reader2 = await tryOpenLock(file, Lock.Shared, { range: { offset: 0, length: 100 } })

    expect(reader2).toBeDefined()

    await reader1.drop()
    await reader2?.drop()
  })

  it('exclusive range does not block non-overlapping shared', async () => {
    const file = getPath('range-excl-no-block-shared')

    const writer = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
    const reader = await tryOpenLock(file, Lock.Shared, { range: { offset: 10, length: 10 } })

    expect(reader).toBeDefined()

    await writer.drop()
    await reader?.drop()
  })

  it('releases range lock correctly on guard drop', async () => {
    const file = getPath('range-release')

    const guard1 = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
    await guard1.drop()

    const guard2 = await tryOpenLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
    expect(guard2).toBeDefined()
    await guard2?.drop()
  })

  it('concurrent writes to different ranges are safe', async () => {
    const file = getPath('range-concurrent-writes')
    const count = 10

    await Promise.all(
      Array.from({ length: count }).map(async (_, i) => {
        const offset = i * 4
        await using guard = await openLock(file, Lock.Exclusive, { range: { offset, length: 4 } })
        const buf = Buffer.alloc(4)
        buf.writeUint32LE(i + 1, 0)
        await guard.handle.write(buf, 0, 4, offset)
      }),
    )

    // Verify each range was written correctly
    await using guard = await openLock(file, Lock.Shared, { range: { offset: 0, length: count * 4 } })
    for (let i = 0; i < count; i++) {
      const buf = Buffer.alloc(4)
      await guard.handle.read(buf, 0, 4, i * 4)
      expect(buf.readUint32LE(0)).toBe(i + 1)
    }
  })
})

describe('range lock contention (cross-process)', () => {
  // fcntl range locks are per-process on macOS (F_SETLK), per-fd on Linux (F_OFD_SETLK).
  // Contention tests must use child processes to work on both platforms.

  it('overlapping exclusive ranges conflict', async () => {
    const file = getPath('range-overlap')

    const child = await spawnChild()
    await child.exec(
      async ({ openLock, Lock }, file) => {
        ;(globalThis as any).__lock = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 20 } })
        return 'locked'
      },
      [file],
    )

    const guard = await tryOpenLock(file, Lock.Exclusive, { range: { offset: 10, length: 20 } })
    expect(guard).toBeUndefined()

    child.kill()
    await child.exit
  })

  it('exclusive range blocks shared on overlapping range', async () => {
    const file = getPath('range-excl-blocks-shared')

    const child = await spawnChild()
    await child.exec(
      async ({ openLock, Lock }, file) => {
        ;(globalThis as any).__lock = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 50 } })
        return 'locked'
      },
      [file],
    )

    const guard = await tryOpenLock(file, Lock.Shared, { range: { offset: 25, length: 50 } })
    expect(guard).toBeUndefined()

    child.kill()
    await child.exit
  })

  it('shared range blocks exclusive on overlapping range', async () => {
    const file = getPath('range-shared-blocks-excl')
    await fs.promises.writeFile(file, Buffer.alloc(1024))

    const child = await spawnChild()
    await child.exec(
      async ({ openLock, Lock }, file) => {
        ;(globalThis as any).__lock = await openLock(file, Lock.Shared, { range: { offset: 0, length: 50 } })
        return 'locked'
      },
      [file],
    )

    const guard = await tryOpenLock(file, Lock.Exclusive, { range: { offset: 25, length: 50 } })
    expect(guard).toBeUndefined()

    child.kill()
    await child.exit
  })

  it('polling acquires range lock after holder exits', async () => {
    const file = getPath('range-poll')

    const child = await spawnChild()
    await child.exec(
      async ({ openLock, Lock }, file) => {
        ;(globalThis as any).__lock = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
        return 'locked'
      },
      [file],
    )

    let acquired = false
    const pollingPromise = openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 }, pollMs: 10 }).then(
      (g) => {
        acquired = true
        return g
      },
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(acquired).toBe(false)

    // Killing the child releases its lock
    child.kill()
    await child.exit

    const guard = await pollingPromise
    expect(acquired).toBe(true)
    await guard.drop()
  })

  it('range lock timeout works', async () => {
    const file = getPath('range-timeout')

    const child = await spawnChild()
    await child.exec(
      async ({ openLock, Lock }, file) => {
        ;(globalThis as any).__lock = await openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 } })
        return 'locked'
      },
      [file],
    )

    const attempt = openLock(file, Lock.Exclusive, { range: { offset: 0, length: 10 }, timeout: 100, pollMs: 20 })
    await expect(attempt).rejects.toThrow(/Timed out/)

    child.kill()
    await child.exit
  })
})

describe('range validation', () => {
  it('rejects negative offset', async () => {
    const file = getPath('neg-offset')
    await expect(openLock(file, Lock.Exclusive, { range: { offset: -1, length: 10 } })).rejects.toThrow(
      /cannot be negative/,
    )
  })

  it('rejects negative length', async () => {
    const file = getPath('neg-length')
    await expect(openLock(file, Lock.Exclusive, { range: { offset: 0, length: -5 } })).rejects.toThrow(/Range/)
  })

  it('rejects zero length', async () => {
    const file = getPath('zero-length')
    await expect(openLock(file, Lock.Exclusive, { range: { offset: 0, length: 0 } })).rejects.toThrow(/Range/)
  })

  it('validates on all lock functions', async () => {
    const file = getPath('validate-all-paths')
    await fs.promises.writeFile(file, Buffer.alloc(1024))
    const bad = { range: { offset: -1, length: 10 } }
    await expect(openLock(file, Lock.Shared, bad)).rejects.toThrow(/offset/)
    await expect(tryOpenLock(file, Lock.Exclusive, bad)).rejects.toThrow(/offset/)
    await expect(tryOpenLock(file, Lock.Shared, bad)).rejects.toThrow(/offset/)
  })
})

describe('already-closed fd', () => {
  const noGcFs = {
    async open(file: string, type: Lock) {
      const flags = type === Lock.Exclusive ? fs.constants.O_CREAT | fs.constants.O_RDWR : fs.constants.O_RDONLY
      const fd = fs.openSync(file, flags)
      return {
        fd,
        close: async () => {
          try {
            fs.closeSync(fd)
          } catch {}
        },
      }
    },
  }

  it('guard.drop() rejects but still marks guard as dropped', async () => {
    const file = getPath('closed-fd-drop')
    const guard = await openLock(file, Lock.Exclusive, { fs: noGcFs as any })

    // Close the raw fd behind the guard's back
    fs.closeSync(guard.fd)

    // drop() will fail (EBADF on unlock/close), but guard should still be marked dropped
    await expect(guard.drop()).rejects.toThrow()
    expect(guard.dropped).toBe(true)
  })

  it('lock is released after fd is closed (new lock is acquirable)', async () => {
    const file = getPath('closed-fd-reacquire')
    const guard = await openLock(file, Lock.Exclusive, { fs: noGcFs as any })
    fs.closeSync(guard.fd)
    await guard.drop().catch(() => {})

    const guard2 = await tryOpenLock(file, Lock.Exclusive)
    expect(guard2).toBeDefined()
    await guard2?.drop()
  })
})

describe('hook state after unlock failure', () => {
  it('unregister runs even when native unlock throws', async () => {
    let unregisterCalled = false
    const hooks = {
      register: async () => {},
      unregister: async () => {
        unregisterCalled = true
      },
    }
    const locker = createLocker(hooks)

    await expect(locker.unlock(-999)).rejects.toThrow()
    expect(unregisterCalled).toBe(true)
  })

  it('unregister cleans up hook state after guard.drop() with closed fd', async () => {
    let activeCount = 0
    const hooks = {
      register: async () => {
        activeCount++
      },
      unregister: async () => {
        activeCount--
      },
    }
    const locker = createLocker(hooks)

    // Use fs.openSync to avoid creating a FileHandle with a GC finalizer
    const fd = fs.openSync(getPath('hook-cleanup'), fs.constants.O_CREAT | fs.constants.O_RDWR)

    await locker.lock(fd, Lock.Exclusive)
    expect(activeCount).toBe(1)

    // Close fd to force unlock failure
    fs.closeSync(fd)
    await locker.unlock(fd).catch(() => {})

    // Hook should have decremented despite the unlock failure
    expect(activeCount).toBe(0)
  })
})
