// @ts-check
import fs from 'node:fs'

/**
 * Write a 32-bit unsigned integer to a file handle at offset 0.
 * @param {fs.promises.FileHandle} handle - The file handle to write to
 * @param {number} value - The value to write
 * @returns {Promise<void>}
 */
export const writeInt = async (handle, value) => {
  const buf = Buffer.alloc(4)
  buf.writeUint32LE(value, 0)
  await handle.write(buf, 0, 4, 0)
}

/**
 * Read a 32-bit unsigned integer from a file handle at offset 0.
 * @param {fs.promises.FileHandle} handle - The file handle to read from
 * @returns {Promise<number>} The value read
 */
export const readInt = async (handle) => {
  const buf = Buffer.alloc(4)
  await handle.read(buf, 0, 4, 0)
  return buf.readUint32LE(0)
}