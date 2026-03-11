# @lickle/lock

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/lickle-lock/CI.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/lickle-lock/actions?query=workflow:CI)
[![Build Size](https://img.shields.io/bundlephobia/minzip/@lickle/lock?label=bundle%20size&style=flat&colorA=000000&colorB=000000)](https://bundlephobia.com/result?p=@lickle/lock)
[![Version](https://img.shields.io/npm/v/@lickle/lock?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/lock)
[![Downloads](https://img.shields.io/npm/dt/@lickle/lock.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/lock)

File-based locking for Node.js using **native OS locks** (`flock` on Unix, `LockFileEx` on Windows).

Supports:

- **Exclusive (write) locks**
- **Shared (read) locks**
- **Cross-process / cross-thread coordination**
- **Automatic cleanup** on exit, signals, and garbage collection

---

## Install

```bash
npm install @lickle/lock
```

---

# Quick Start

```ts
import { exclusive } from '@lickle/lock'

await using guard = await exclusive('/tmp/my.lock')

// access the files handle through the guard
await guard.handle.readFile({ encoding: 'utf-8' })

// lock automatically released when guard goes out of scope
```

Locks work **across processes and worker threads**, making them suitable for coordinating filesystem access.

---

# API

## `exclusive(file, options?)`

Acquire an **exclusive (write) lock**.

Blocks until the lock becomes available.

```ts
import { exclusive } from '@lickle/lock'

const guard = await exclusive('/tmp/my.lock')

try {
  // critical section
} finally {
  await guard.drop()
}
```

---

## `shared(file, options?)`

Acquire a **shared (read) lock**.

Multiple shared locks can coexist, but they block exclusive locks.

```ts
import { shared } from '@lickle/lock'

const reader1 = await shared('/tmp/data.lock')
const reader2 = await shared('/tmp/data.lock')

await reader1.drop()
await reader2.drop()
```

---

## `tryExclusive(file)`

Attempt to acquire an exclusive lock **without waiting**.

Returns `undefined` if the lock is already held.

```ts
import { tryExclusive } from '@lickle/lock'

const guard = await tryExclusive('/tmp/my.lock')

if (guard) {
  // acquired lock
  await guard.drop()
}
```

---

## `tryShared(file)`

Attempt to acquire a shared lock **without waiting**.

Returns `undefined` if an exclusive lock is currently held.

```ts
import { tryShared } from '@lickle/lock'

const guard = await tryShared('/tmp/data.lock')
```

---

# Options

Both `exclusive` and `shared` accept:

```ts
{
  pollMs?: number   // polling interval (default: 10ms)
  timeout?: number  // max wait time before throwing
  backend?: Backend // custom backend
}
```

Example:

```ts
await exclusive('/tmp/my.lock', {
  pollMs: 20,
  timeout: 1000,
})
```

If the lock cannot be acquired within the timeout:

```
Error: Timed out acquiring lock
```

---

# FileGuard

Lock functions return a **`FileGuard`**.

The guard manages the lifetime of the lock.

```ts
const guard = await exclusive('/tmp/my.lock')

guard.handle // fs.promises.FileHandle
guard.fd // file descriptor
guard.path // lock file path
guard.dropped // boolean

await guard.drop()
```

---

## Automatic cleanup with `await using`

`FileGuard` implements the **Explicit Resource Management** proposal.

```ts
await using guard = await exclusive('/tmp/my.lock')

const text = await guard.handle.readFile('utf8')
```

The lock is automatically released when the scope exits.

Spec:
[https://github.com/tc39/proposal-explicit-resource-management](https://github.com/tc39/proposal-explicit-resource-management)

---

# Cleanup Guarantees

Locks are released automatically when:

- the process exits
- `SIGINT` or `SIGTERM` is received
- a worker thread shuts down
- the guard is garbage collected

This prevents stale locks if your program crashes.

---

# Backends

The default backend uses native OS locks:

- **Unix:** `flock`
- **Windows:** `LockFileEx`

You can implement custom backends for alternative file systems or environments.

---

# License

MIT © Dan Beaven
