import path from 'node:path'
import fs from 'node:fs'

Error.stackTraceLimit = 100

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason)
})

import { Lock, lock, lockSync, tryLock, tryLockSync } from '../esm.js'

const locksDir = path.join(import.meta.dirname, './locks-windows')
const getPath = (name: string) => path.join(locksDir, name)

try {
  console.log('mkdir')
  await fs.promises.mkdir(locksDir, { recursive: true })

  console.log('open')
  const file = getPath('test.lock')
  const handle = await fs.promises.open(file, 'w')
  console.log('tryLock', handle.fd)
  await tryLock(handle.fd, Lock.Exclusive)
  console.log('tryLock done')
} catch (error) {
  console.error(error)
}

await fs.promises.rm(locksDir, { recursive: true })
