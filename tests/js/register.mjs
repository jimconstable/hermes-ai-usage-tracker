// `node --import ./tests/js/register.mjs --test tests/js/` — resolve the desktop host's
// modules to the local stub so plugin.js loads outside the Hermes desktop.
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
const STUB = ${JSON.stringify(new URL('./sdk-stub.mjs', import.meta.url).href)}
export async function resolve(specifier, context, next) {
  if (specifier === '@hermes/plugin-sdk' || specifier === 'react' || specifier === 'react/jsx-runtime') {
    return { url: STUB, shortCircuit: true }
  }
  return next(specifier, context)
}`)
)
