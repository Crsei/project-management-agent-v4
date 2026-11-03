import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { liveOpenCodeInventory, registerLiveOpenCodeInventory } from "./liveWorkspace.ts";

it("only lends inventory from the exact live native execution and releases it", async () => {
  const release = registerLiveOpenCodeInventory("provider-a", "thread-a", "run-a", "/one", () =>
    Effect.succeed({ skills: [{ name: "one", path: "native:one", enabled: true }], commands: [] }),
  );
  try {
    expect(liveOpenCodeInventory("provider-a", "thread-a", "run-b", "/one")).toBeUndefined();
    expect(liveOpenCodeInventory("provider-a", "thread-a", "run-a", "/two")).toBeUndefined();
    expect(liveOpenCodeInventory("provider-b", "thread-a", "run-a", "/one")).toBeUndefined();
    const read = liveOpenCodeInventory("provider-a", "thread-a", "run-a", "/one");
    expect(read).toBeDefined();
    expect((await Effect.runPromise(read!())).skills[0]?.path).toBe("native:one");
  } finally {
    release();
  }
  expect(liveOpenCodeInventory("provider-a", "thread-a", "run-a", "/one")).toBeUndefined();
});
