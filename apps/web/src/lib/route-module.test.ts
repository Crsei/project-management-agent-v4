import assert from "node:assert/strict"
import test from "node:test"
import { createRouteModuleLoader } from "./route-module.ts"

test("route preload shares the real pending request and successful module", async () => {
  let calls = 0
  const module = { default: "Agent" }
  const { promise: request, resolve } = Promise.withResolvers<typeof module>()
  const load = createRouteModuleLoader(() => { calls += 1; return request })
  const first = load()
  assert.equal(load(), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  resolve(module)
  assert.equal(await first, module)
  assert.equal(await load(), module)
  assert.equal(calls, 1)
})

test("failed route imports release their request so an explicit retry can load", async () => {
  let calls = 0
  const error = new Error("Chunk unavailable")
  const load = createRouteModuleLoader(async () => {
    calls += 1
    if (calls === 1) throw error
    return "loaded"
  })
  const failed = load()
  assert.equal(load(), failed)
  await assert.rejects(failed, error)
  assert.equal(await load(), "loaded")
  assert.equal(calls, 2)
})

test("synchronous importer errors also release the request", async () => {
  let calls = 0
  const load = createRouteModuleLoader(() => {
    if (++calls === 1) throw new Error("Unavailable importer")
    return Promise.resolve("loaded")
  })
  await assert.rejects(load(), /Unavailable importer/)
  assert.equal(await load(), "loaded")
})
