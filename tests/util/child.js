import * as Lock from '../../dist/esm/index.js'
import * as Util from './util.js'

const context = { ...Lock, ...Util }

/**
 * NOTE: Functions are serialized via `fn.toString()` and reconstructed with
 * `new Function`. This means closures over external variables or imports will
 * NOT work — only values available through the `context` argument are accessible.
 *
 * Good:  async ({ exclusive }, file) => { await exclusive(file) }
 * Bad:   async (ctx, file) => { await someImportedHelper(file) }
 */
process.on('message', async (msg) => {
  const fn = new Function('return ' + msg.code)()
  try {
    const result = await fn(context, ...msg.args)
    process.send?.({ id: msg.id, ok: true, result })
  } catch (error) {
    console.error(error)
    process.send?.({ id: msg.id, ok: false, error: serializeError(error) })
  }
})

function serializeError(error) {
  if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack }
  return { message: String(error), name: 'UnknownError' }
}