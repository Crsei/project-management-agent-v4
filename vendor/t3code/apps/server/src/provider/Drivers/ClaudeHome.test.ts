import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("resolves inherited relative paths against bound cwd without shell expansion", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve("/fixture/native-project");
        const environment = { CLAUDE_CONFIG_DIR: "~/literal-native-home" };
        const resolved = yield* resolveClaudeHomePath({ homePath: "" }, environment).pipe(
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        expect(resolved).toBe(path.resolve(cwd, "~/literal-native-home"));
        expect((yield* makeClaudeEnvironment({ homePath: "" }, environment)).CLAUDE_CONFIG_DIR)
          .toBe("~/literal-native-home");
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("uses only the bound native environment and never rewrites HOME/XDG to app state", () =>
      Effect.gen(function* () {
        const bound = { HOME: "/fixture/user", XDG_CONFIG_HOME: "/fixture/xdg", CLAUDE_CONFIG_DIR: "/fixture/claude",
          ANTHROPIC_API_KEY: "fixture-only-key", ENABLE_CLAUDEAI_MCP_SERVERS: "true" };
        const environment = yield* makeClaudeEnvironment({ homePath: "" }).pipe(
          Effect.provideService(HostProcess.Environment, bound),
        );
        expect(environment.HOME).toBe(bound.HOME);
        expect(environment.XDG_CONFIG_HOME).toBe(bound.XDG_CONFIG_HOME);
        expect(environment.CLAUDE_CONFIG_DIR).toBe(bound.CLAUDE_CONFIG_DIR);
        expect(environment.ANTHROPIC_API_KEY).toBe(bound.ANTHROPIC_API_KEY);
        expect(environment.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
        expect(environment.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("0");
        expect(environment.PATH).toBeUndefined();
      }),
    );
  });
});
