"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderDriverDefinition,
  ProviderInstance,
  ProviderInstanceInput,
  ProviderInstanceUpdate,
  ProviderTestResult,
  ProvidersResponse,
} from "@agent-workspace/contracts/provider";
import { workspaceClient } from "@agent/src/network";
import { agentText } from "@agent/src/i18n-text.ts";

const ACTIVE_AUTH_PHASES: Record<ProviderAuthState["phase"], boolean> = {
  idle: false,
  starting: true,
  waiting: true,
  verifying: true,
  succeeded: false,
  failed: false,
  cancelled: false,
};

export type AcpRegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  website?: string;
  repository?: string;
  icon?: string;
  distributions: string[];
  integrity?: "sha256" | "registry";
};
export type AcpPreparation = { message: string; agentId?: string; version?: string; distribution?: string; commandPath?: string };

const providerPath = (instanceId: string, suffix = "") =>
  `/api/providers/${encodeURIComponent(instanceId)}${suffix}`;

const isTestResult = (value: unknown): value is ProviderTestResult =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  typeof value.ok === "boolean" &&
  "latencyMs" in value &&
  typeof value.latencyMs === "number";

const normalizeTestResult = (value: ProviderTestResult): ProviderTestResult => ({
  ok: value?.ok === true,
  latencyMs:
    typeof value?.latencyMs === "number" && Number.isFinite(value.latencyMs) ? value.latencyMs : 0,
  ...(typeof value?.checkedAt === "string" ? { checkedAt: value.checkedAt } : {}),
  ...(typeof value?.instanceRevision === "number" ? { instanceRevision: value.instanceRevision } : {}),
  ...(value?.kind ? { kind: value.kind } : {}),
  ...(value?.authentication ? { authentication: value.authentication } : {}),
  ...(typeof value?.requiresOpenaiAuth === "boolean" ? { requiresOpenaiAuth: value.requiresOpenaiAuth } : {}),
  ...(typeof value?.nativeSessionReady === "boolean" ? { nativeSessionReady: value.nativeSessionReady } : {}),
  ...(typeof value?.error === "string" && value.error ? { error: value.error } : {}),
  ...(Array.isArray(value?.models) ? { models: value.models } : {}),
});

/** Native provider metadata and actions. Secret values are sent only in requests. */
export const useProviders = () => {
  const [providers, setProviders] = useState<ProviderInstance[]>([]);
  const [drivers, setDrivers] = useState<ProviderDriverDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<ProviderAuthState | null>(null);
  const [authInstanceId, setAuthInstanceId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const authEpoch = useRef(0);
  const snapshotEpoch = useRef(0);

  const invalidateReadiness = useCallback((instanceId: string) => {
    snapshotEpoch.current += 1;
    setLoading(false);
    setProviders(current => current.map(provider => provider.instanceId === instanceId ? {
      ...provider, nativeSessionReady: false, configured: false, authStatus: "unknown",
      authLabel: undefined, email: undefined, authCheckedAt: undefined,
      requiresOpenaiAuth: undefined, lastConnectionTest: undefined,
    } : provider));
  }, []);

  const refresh = useCallback(async () => {
    const epoch = ++snapshotEpoch.current;
    setLoading(true);
    try {
      const data = await workspaceClient.json<ProvidersResponse>("/api/providers");
      if (epoch !== snapshotEpoch.current) return;
      setProviders(Array.isArray(data?.providers) ? data.providers : []);
      setDrivers(Array.isArray(data?.drivers) ? data.drivers : []);
      setError(null);
    } catch (cause) {
      if (epoch !== snapshotEpoch.current) return;
      setError(cause instanceof Error && cause.message ? cause.message : agentText("请求失败，请稍后重试。", "The request failed. Try again later."));
    } finally {
      if (epoch === snapshotEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const authPhase = authState?.phase ?? null;

  useEffect(() => {
    if (!authInstanceId || !authPhase || !ACTIVE_AUTH_PHASES[authPhase]) return;
    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await workspaceClient.json<ProviderAuthState>(
          providerPath(authInstanceId, "/auth"),
        );
        if (cancelled || !next || typeof next.phase !== "string") return;
        setAuthState(next);
        setAuthError(null);
        if (next.phase === "succeeded" || next.phase === "failed" || next.phase === "cancelled")
          await refresh();
      } catch (cause) {
        if (!cancelled)
          setAuthError(cause instanceof Error && cause.message ? cause.message : agentText("无法获取登录状态。", "Could not read sign-in status."));
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authInstanceId, authPhase, refresh]);


  const test = useCallback(async (instanceId: string): Promise<ProviderTestResult> => {
    invalidateReadiness(instanceId);
    const result = await workspaceClient.json<ProviderTestResult>(
      providerPath(instanceId, "/test"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!isTestResult(result)) throw new Error(agentText("服务未返回可确认的检查结果。", "The service did not return a verifiable check result."));
    await refresh();
    return normalizeTestResult(result);
  }, [invalidateReadiness, refresh]);


  const logout = useCallback(
    async (instanceId: string): Promise<void> => {
      invalidateReadiness(instanceId);
      const result = await workspaceClient.json<{ ok?: boolean; message?: string }>(
        providerPath(instanceId, "/logout"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      await refresh();
      if (result?.ok === false) {
        throw new Error(result.message ?? agentText("退出登录未得到 CLI 确认。", "Sign-out was not confirmed by the CLI."));
      }
    },
    [invalidateReadiness, refresh],
  );

  const loadAuth = useCallback(async (instanceId: string): Promise<ProviderAuthState> => {
    const epoch = authEpoch.current;
    const state = await workspaceClient.json<ProviderAuthState>(providerPath(instanceId, "/auth"));
    if (!state || typeof state.phase !== "string") throw new Error(agentText("服务未返回登录状态。", "The service did not return sign-in status."));
    if (epoch === authEpoch.current) {
      setAuthError(null);
      setAuthInstanceId(instanceId);
      setAuthState(state);
      if (ACTIVE_AUTH_PHASES[state.phase]) invalidateReadiness(instanceId);
    }
    return state;
  }, [invalidateReadiness]);

  const startAuth = useCallback(
    async (instanceId: string, input: ProviderAuthStartInput = {}): Promise<ProviderAuthState> => {
      const epoch = authEpoch.current;
      invalidateReadiness(instanceId);
      const state = await workspaceClient.json<ProviderAuthState>(
        providerPath(instanceId, "/auth/start"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!state || typeof state.phase !== "string")
        throw new Error(agentText("服务未返回登录状态，请稍后重试。", "The service did not return sign-in status. Try again later."));
      if (epoch !== authEpoch.current) {
        if (state.flowId) {
          await workspaceClient
            .json(providerPath(instanceId, "/auth/cancel"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ flowId: state.flowId }),
            })
            .catch(() => undefined);
        }
        return state;
      }
      setAuthError(null);
      setAuthInstanceId(instanceId);
      setAuthState(state);
      if (!ACTIVE_AUTH_PHASES[state.phase]) await refresh();
      return state;
    },
    [invalidateReadiness, refresh],
  );

  const cancelAuth = useCallback(async (instanceId: string, flowId: string): Promise<void> => {
    const state = await workspaceClient.json<ProviderAuthState>(
      providerPath(instanceId, "/auth/cancel"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      },
    );
    if (state && typeof state.phase === "string") {
      setAuthState((previous) =>
        previous?.instanceId === instanceId && previous.flowId === flowId ? state : previous,
      );
    } else {
      const next = await workspaceClient.json<ProviderAuthState>(providerPath(instanceId, "/auth"));
      if (next && typeof next.phase === "string") {
        setAuthState((previous) =>
          previous?.instanceId === instanceId && previous.flowId === flowId ? next : previous,
        );
      }
    }
    await refresh();
  }, [refresh]);

  const sendAuthInput = useCallback(
    async (instanceId: string, flowId: string, input: string): Promise<void> => {
      const state = await workspaceClient.json<ProviderAuthState>(
        providerPath(instanceId, "/auth/input"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId, input }),
        },
      );
      if (state && typeof state.phase === "string") {
        setAuthState((previous) =>
          previous?.instanceId === instanceId && previous.flowId === flowId ? state : previous,
        );
        if (!ACTIVE_AUTH_PHASES[state.phase]) await refresh();
      }
    },
    [refresh],
  );

  const clearAuth = useCallback(() => {
    authEpoch.current += 1;
    setAuthState(null);
    setAuthInstanceId(null);
    setAuthError(null);
  }, []);

  const createInstance = useCallback(
    async (input: ProviderInstanceInput): Promise<ProviderInstance> => {
      snapshotEpoch.current += 1;
      setLoading(false);
      const provider = await workspaceClient.json<ProviderInstance>("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setProviders(current => [...current.filter(entry => entry.instanceId !== provider.instanceId), provider]);
      await refresh();
      return provider;
    },
    [refresh],
  );

  const updateInstance = useCallback(
    async (
      instanceId: string,
      input: ProviderInstanceUpdate & { revision?: number },
    ): Promise<ProviderInstance> => {
      snapshotEpoch.current += 1;
      setLoading(false);
      const provider = await workspaceClient.json<ProviderInstance>(providerPath(instanceId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setProviders(current => current.map(entry => entry.instanceId === instanceId ? provider : entry));
      await refresh();
      return provider;
    },
    [refresh],
  );

  const removeInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      snapshotEpoch.current += 1;
      setLoading(false);
      await workspaceClient.json(providerPath(instanceId), { method: "DELETE" });
      setProviders(current => current.filter(provider => provider.instanceId !== instanceId));
      await refresh();
    },
    [refresh],
  );
  const resetInstance = useCallback(async (instanceId: string, revision: number): Promise<ProviderInstance | null> => {
    invalidateReadiness(instanceId);
    const provider = await workspaceClient.json<ProviderInstance | null>(providerPath(instanceId, "/reset"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }),
    });
    const resetProvider = provider ? { ...provider, nativeSessionReady: false, configured: false } : null;
    setProviders(current => resetProvider
      ? current.map(entry => entry.instanceId === instanceId ? resetProvider : entry)
      : current.filter(entry => entry.instanceId !== instanceId));
    await refresh();
    return resetProvider;
  }, [invalidateReadiness, refresh]);
  const searchAcpRegistry = useCallback(async (query: string): Promise<{ agents: AcpRegistryAgent[]; total: number }> =>
    workspaceClient.json(`/api/providers/acp-registry/search?q=${encodeURIComponent(query)}&limit=30`), []);


  return {
    providers,
    drivers,
    loading,
    error,
    refresh,
    createInstance,
    updateInstance,
    removeInstance,
    resetInstance,
    searchAcpRegistry,
    test,
    logout,
    loadAuth,
    startAuth,
    cancelAuth,
    sendAuthInput,
    authState,
    authInstanceId,
    authError,
    clearAuth,
  };
};
