// @ts-check
import fs from 'node:fs'

/**
 * Write a 32-bit integer to a file handle
 * @param {fs.promises.FileHandle} handle - The file handle to write to
 * @param {number} value - The value to write
 * @returns {Promise<void>} The number of bytes written
 */
export const writeInt = async (handle, value) => {
  const buf = Buffer.alloc(4)
  buf.writeUint32LE(value, 0)
  await handle.write(buf, 0, 4, 0)
  return;
}

/**
 * Read a 32-bit integer from a file handle
 * @param {fs.promises.FileHandle} handle - The file handle to read from
 * @returns {Promise<number>} The value read
 */
export const readInt = async (handle) => {
  const buf = Buffer.alloc(4)
  await handle.read(buf, 0, 4, 0)
  return buf.readUint32LE(0)
}
