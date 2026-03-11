import * as Lock from '../../dist/esm/index.js'
import * as Util from './util.js'

const context = { ...Lock, ...Util }

process.on('message', async (msg) => {
  const fn = new Function('return ' + msg.code)() 
  try {
    const result = await fn(context, ...msg.args)
    process.send?.({ id: msg.id, ok: true, result })
  } catch (error) {
    console.error(error)
    process.send?.({
      id: msg.id,
      ok: false,
      error: serializeError(error),
    })
  }
})

function serializeError(error) {
  if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack }
  return { message: String(error), name: 'UnknownError' }
}
