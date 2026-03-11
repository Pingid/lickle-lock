import { createNodeBackend, NodeFileHandle } from './node.js'
import { type Backend } from './types.js'

export * from './lockable.js'
export * from './types.js'
export * from './guard.js'
export * from './node.js'

/** Return the shared default Node backend singleton. */
let _defaultBackend: Backend<NodeFileHandle> | undefined
export const defaultBackend = () => {
  if (!_defaultBackend) _defaultBackend = createNodeBackend()
  return _defaultBackend
}
