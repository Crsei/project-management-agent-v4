import { expect, it } from "@effect/vitest";
import { liveAcpWorkspace, registerLiveAcpWorkspace } from "./liveWorkspace.ts";

it("exposes only the exact live ACP execution and removes it on session close", () => {
  let ready = false;
  const release = registerLiveAcpWorkspace("provider", "thread", "run", "/one", () =>
    ready ? [{ name: "review", description: "Native review" }] : undefined,
  );
  try {
    expect(liveAcpWorkspace("provider", "thread", "other", "/one")).toBeUndefined();
    expect(liveAcpWorkspace("provider", "thread", "run", "/two")).toBeUndefined();
    const read = liveAcpWorkspace("provider", "thread", "run", "/one")!;
    expect(read()).toBeUndefined();
    ready = true;
    expect(read()?.[0]?.name).toBe("review");
  } finally { release(); }
  expect(liveAcpWorkspace("provider", "thread", "run", "/one")).toBeUndefined();
});
