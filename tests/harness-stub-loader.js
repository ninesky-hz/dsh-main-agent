// Minimal ESM resolver shim so the Harness-free test process can import
// `lib/goal.js`, whose module scope pulls `@deepseek-ai/dsh-llm` and
// `@deepseek-ai/dsh-tools`. Those packages ship inside the dsh application
// bundle, not in this repository, so the stubs reproduce only the exact
// surface `lib/goal.js` uses. See tests/goal-tools.test.mjs.
const STUBS = new Map([
  ['@deepseek-ai/dsh-llm', `
export class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
export function boundContextSummary(summary) {
  return summary.length <= 120 ? summary : summary.slice(0, 119) + '\\u2026'
}
export function createUserMessage(input) {
  return { ...input, id: 'message-' + Math.random().toString(36).slice(2), role: 'user' }
}
`],
  ['@deepseek-ai/dsh-tools', `
export function defineTool(definition) {
  return definition
}
`],
  // `lib/index.js` only needs its Config schema to be *constructible* at import
  // time; these tests never parse a value through it. A self-returning builder
  // stands in for schemastery's chainable schema API.
  ['@deepseek-ai/schemastery', `
function builder() {
  const self = new Proxy(function () {}, {
    get(_target, property) {
      if (property === 'then') return undefined
      return builder
    },
    apply() { return builder },
    construct() { return builder },
  })
  return self
}
export default { object: builder, string: builder, number: builder, boolean: builder,
  natural: builder, union: builder, const: builder, dict: builder, array: builder, any: builder }
`],
])

function stubUrl(specifier) {
  return `goal-tools-stub:${encodeURIComponent(specifier)}`
}

export async function resolve(specifier, context, nextResolve) {
  if (STUBS.has(specifier)) return { url: stubUrl(specifier), shortCircuit: true }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('goal-tools-stub:')) {
    const specifier = decodeURIComponent(url.slice('goal-tools-stub:'.length))
    return { format: 'module', source: STUBS.get(specifier), shortCircuit: true }
  }
  return nextLoad(url, context)
}
