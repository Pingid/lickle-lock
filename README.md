# @lickle/lock

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/lickle-lock/CI.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/lickle-lock/actions?query=workflow:CI)
[![Version](https://img.shields.io/npm/v/@lickle/lock?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/lock)
[![Downloads](https://img.shields.io/npm/dw/@lickle/lock?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/lock)
[![License](https://img.shields.io/github/license/Pingid/lickle-lock?style=flat&colorA=000000&colorB=000000)](./LICENSE)

File-based locking for Node.js using native OS locks (`flock` on Unix, `LockFileEx` on Windows).

---

## Install

```bash
npm install @lickle/lock
```

---

## Quick Start

```ts
import { openLock, Lock } from '@lickle/lock'

await using guard = await openLock('/tmp/my.lock', Lock.Exclusive)

// access the file handle through the guard
await guard.handle.readFile({ encoding: 'utf-8' })

// lock automatically released when guard goes out of scope
```

Locks work **across processes and worker threads**, making them suitable for coordinating filesystem access.

---

## API

### `openLock(file, type, options?)`

Open a file and acquire a lock, polling until available. Returns a `FileLockGuard`.

```ts
import { openLock, Lock } from '@lickle/lock'

const guard = await openLock('/tmp/my.lock', Lock.Exclusive)

try {
  // critical section
} finally {
  await guard.drop()
}
```

### `tryOpenLock(file, type, options?)`

Open a file and try to acquire a lock **without waiting**. Returns `undefined` if the lock is not available.

```ts
import { tryOpenLock, Lock } from '@lickle/lock'

const guard = await tryOpenLock('/tmp/my.lock', Lock.Exclusive)

if (guard) {
  // acquired lock
  await guard.drop()
}
```

### `lock(handle, type, options?)`

Acquire a lock on an already-open file handle. Returns a `LockGuard` (does not close the file on drop).

```ts
import fs from 'node:fs/promises'
import { lock, Lock } from '@lickle/lock'

const handle = await fs.open('/tmp/my.lock', 'r+')
await using guard = await lock(handle, Lock.Exclusive)
```

### `tryLock(handle, type, options?)`

Try to acquire a lock on an already-open file handle **without waiting**. Returns `undefined` if the lock is not available.

```ts
import fs from 'node:fs/promises'
import { tryLock, Lock } from '@lickle/lock'

const handle = await fs.open('/tmp/my.lock', 'r+')
const guard = await tryLock(handle, Lock.Exclusive)

if (guard) {
  // acquired lock
}
```

### `unlock(handle, options?)`

Release a lock on a file descriptor or file handle.

```ts
import fs from 'node:fs/promises'
import { lock, unlock, Lock } from '@lickle/lock'

const handle = await fs.open('/tmp/my.lock', 'r+')
await lock(handle, Lock.Exclusive)
// ... critical section ...
await unlock(handle)
```

---

## Options

`openLock` and `lock` accept `PollOptions`:

```ts
{
  pollMs?: number   // polling interval (default: 10ms)
  timeout?: number  // max wait time before throwing
  backoff?: number  // multiplier applied to pollMs after each attempt (e.g. 2 = exponential)
}
```

All functions accept `LockingOptions`:

```ts
{
  locking?: Locker   // custom locker implementation
  range?: LockRange  // byte range to lock (see Range Locks)
}
```

`openLock` and `tryOpenLock` additionally accept:

```ts
{
  fs?: Fs  // custom filesystem for opening files
}
```

Example:

```ts
await openLock('/tmp/my.lock', Lock.Exclusive, {
  pollMs: 10,
  backoff: 2,
  timeout: 5000,
})
```

If the lock cannot be acquired within the timeout:

```
Error: Timed out acquiring lock
```

---

## Range Locks

Lock a specific byte range within a file instead of the entire file. This allows multiple processes to lock different regions concurrently.

```ts
import { openLock, Lock } from '@lickle/lock'

// lock bytes 0–99
await using header = await openLock('/tmp/data.bin', Lock.Exclusive, {
  range: { offset: 0, length: 100 },
})

// lock bytes 100–199 concurrently — no conflict
await using body = await openLock('/tmp/data.bin', Lock.Exclusive, {
  range: { offset: 100, length: 100 },
})
```

Range locks also work with `tryOpenLock`, `lock`, and `tryLock`.

```ts
const guard = await tryOpenLock('/tmp/data.bin', Lock.Exclusive, {
  range: { offset: 0, length: 512 },
})
```

When no range is specified, the entire file is locked (the default).

See [Platform Notes](#platform-notes) for important platform-specific behavior of range locks.

---

## Guards

Lock functions return guards that manage the lifetime of the lock.

### `FileLockGuard`

Returned by `openLock` and `tryOpenLock`. Owns both the lock and the file handle — dropping it unlocks and closes the file.

```ts
const guard = await openLock('/tmp/my.lock', Lock.Exclusive)

guard.handle // fs.promises.FileHandle
guard.fd // file descriptor
guard.dropped // boolean

await guard.drop()
```

### `LockGuard`

Returned by `lock` and `tryLock`. Owns only the lock — dropping it unlocks but does not close the file.

```ts
const guard = await lock(handle, Lock.Exclusive)

guard.fd // file descriptor
guard.dropped // boolean

await guard.drop()
```

### Automatic cleanup with `await using`

Both guards implement the [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) proposal.

```ts
await using guard = await openLock('/tmp/my.lock', Lock.Exclusive)

const text = await guard.handle.readFile('utf8')
```

The lock is automatically released when the scope exits.

---

## Customization

The default implementation uses native OS locks and Node.js `fs` for file operations. You can customize either piece independently.

### `Fs` — file opening

Controls how lock files are opened. Implement the `Fs` interface to use alternative file systems.

```ts
import { openLock, Lock, type Fs } from '@lickle/lock'

const myFs: Fs<MyHandle> = {
  open: (file, type) => /* your open logic */,
}

await openLock('/tmp/my.lock', Lock.Exclusive, { fs: myFs })
```

### `Locker` — lock operations

Controls how locks are acquired and released. Use `createLocker()` with custom hooks or implement `Locker` directly.

```ts
import { lock, Lock, createLocker } from '@lickle/lock'

const locker = createLocker(myHooks)
await lock(handle, Lock.Exclusive, { locking: locker })
```

The default locker uses:

- **Unix:** `flock(2)` (whole-file), `fcntl(2)` (byte-range)
- **Windows:** `LockFileEx` / `UnlockFileEx` (both whole-file and byte-range)

---

## Platform Notes

The locking primitives used by this library differ across operating systems. The table below summarizes the syscalls and their behavior.

|                 | Whole-file lock | Range lock                                | Range lock scope     |
| --------------- | --------------- | ----------------------------------------- | -------------------- |
| **Linux**       | `flock(2)`      | `fcntl(2)` OFD locks (`F_OFD_SETLK`)      | per file-description |
| **macOS / BSD** | `flock(2)`      | `fcntl(2)` POSIX record locks (`F_SETLK`) | per process          |
| **Windows**     | `LockFileEx`    | `LockFileEx` (with offset/length)         | per handle           |

### Linux

Range locks use Open File Description (OFD) locks, available since Linux 3.15. OFD locks are scoped to the **file description** (the kernel object behind an `open()` call), not the process. This means different threads holding different file descriptors can hold independent range locks safely.

### Windows

Both whole-file and range locks use `LockFileEx`/`UnlockFileEx`. Locks are scoped to the file handle and do not interfere across handles within the same process.

### macOS / BSD — POSIX record lock caveat

On macOS and BSD, range locks use classic POSIX record locks (`fcntl` with `F_SETLK`/`F_SETLKW`). These locks have a well-documented flaw in the POSIX.1 specification:

> **Closing _any_ file descriptor for a given file releases _all_ locks the process holds on that file.**

If thread A holds a range lock on `data.db` via fd 5, and thread B independently opens `data.db`, reads a byte, and closes its fd, the kernel silently releases thread A's lock. This is specified behavior — not a bug.

This means **range locks on macOS are not safe for intra-process concurrency** when multiple threads or code paths may open the same file. The lock can vanish without warning.

Whole-file locks (`flock`) are **not** affected by this issue — `flock` and `fcntl` are independent locking systems.

**Recommendations:**

- For **inter-process** locking (one lock holder per process), range locks work correctly on all platforms.
- For **intra-process** locking (multiple threads in the same process), range locks are safe on **Linux** (OFD locks) and **Windows**, but **not on macOS/BSD**.
- On macOS, if you need concurrent range locks within a single process, ensure only one file descriptor for the target file is open at a time across all threads, or use whole-file locks instead.

---

## License

MIT © Dan Beaven
