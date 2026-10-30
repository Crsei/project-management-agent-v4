"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { workspaceClient } from "@agent/src/network";
import { threadSettingsSchema, type RemoteSettings, type RemoteThread } from "@agent-workspace/contracts/chat";
import { UNSELECTED_THREAD_SETTINGS, type ChatDefaultsResponse } from "@agent-workspace/contracts/settings";
import { pendingRemoteSettings } from "./remote-settings-patch";
import { acceptRemoteThread } from "@agent/src/pm/state";
import { agentText } from "@agent/src/i18n";

export type ChatSettings = RemoteSettings & { dictation: boolean; speak: boolean };
export type SettingsUpdater = {
  <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]): void;
  (patch: Partial<RemoteSettings>): void;
};
export const SETTINGS_STORAGE_KEY = "agent-workspace:chat-settings";
export type SettingsState = {
  settings: RemoteSettings;
  revision?: number;
  settingsLoaded: boolean;
  loading: boolean;
  saving: boolean;
  ready: boolean;
  error?: string;
  pendingPatch?: Partial<RemoteSettings>;
};
// A control-character prefix cannot collide with a server-valid thread ID.
const DRAFT_PREFIX = "\u0000draft:";
const remoteSettingsKeys = new Set(Object.keys(threadSettingsSchema.shape));
const states = new Map<string, SettingsState>();
const loads = new Map<string, Promise<void>>();
const queues = new Map<string, Promise<void>>();
const bindings = new Map<string, string>();
const initializations = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
const SERVER_STATE: SettingsState = {
  settings: { ...UNSELECTED_THREAD_SETTINGS }, settingsLoaded: false, loading: true, saving: false, ready: false,
};
let voice = { dictation: false, speak: false };
let voiceLoaded = false;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const canonical = (key: string) => bindings.get(key) ?? key;
function notifySettings(): void {
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function stateFor(key: string): SettingsState {
  const id = canonical(key);
  let state = states.get(id);
  if (!state) {
    state = { ...SERVER_STATE, settings: { ...UNSELECTED_THREAD_SETTINGS } };
    states.set(id, state);
  }
  return state;
}
function putState(key: string, state: SettingsState): void {
  states.set(canonical(key), {
    ...state,
    ready: state.settingsLoaded && Boolean(state.settings.providerInstanceId && state.settings.model)
      && !state.loading && !state.saving && !state.error && !state.pendingPatch,
  });
  notifySettings();
}
export function acceptThreadSettings(thread: RemoteThread): void {
  const previous = stateFor(thread.remoteId);
  const pendingPatch = pendingRemoteSettings(previous.pendingPatch, remoteSettingsKeys);
  const current = { ...previous, pendingPatch };
  if (current.revision !== undefined && thread.revision < current.revision) {
    if (current.loading || Object.keys(previous.pendingPatch ?? {}).length !== Object.keys(pendingPatch ?? {}).length)
      putState(thread.remoteId, { ...current, loading: false });
    return;
  }
  putState(thread.remoteId, {
    ...current,
    settings: { ...thread.settings, ...current.pendingPatch },
    revision: thread.revision,
    settingsLoaded: true,
    loading: false,
    error: current.pendingPatch ? current.error : undefined,
  });
}
/** Publish creation and a pending first-save together, before the runtime can send. */
export function acceptInitializedThread(draftId: string, thread: RemoteThread): void {
  const key = `${DRAFT_PREFIX}${draftId}`;
  const draft = states.get(key);
  bindings.set(key, thread.remoteId);
  if (draft?.pendingPatch) {
    const current = stateFor(thread.remoteId);
    states.set(thread.remoteId, {
      ...current,
      settings: { ...thread.settings, ...draft.pendingPatch },
      pendingPatch: { ...current.pendingPatch, ...draft.pendingPatch },
      saving: true,
      error: draft.error,
    });
  }
  states.delete(key);
  acceptThreadSettings(thread);
}
export async function loadThreadSettings(id: string, force = false): Promise<void> {
  if (!force && stateFor(id).settingsLoaded) return;
  if (loads.has(id)) return loads.get(id);
  putState(id, { ...stateFor(id), loading: true });
  const task = workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(id)}`)
    .then(({ thread }) => { acceptThreadSettings(thread); })
    .catch((error: unknown) => {
      putState(id, { ...stateFor(id), loading: false, error: message(error) });
      throw error;
    })
    .finally(() => { if (loads.get(id) === task) loads.delete(id); });
  loads.set(id, task);
  return task;
}
async function loadNewSettings(key: string, force = false): Promise<void> {
  if (bindings.has(key)) return loadThreadSettings(canonical(key), force);
  if (!force && stateFor(key).settingsLoaded) return;
  if (loads.has(key)) return loads.get(key);
  putState(key, { ...stateFor(key), loading: true });
  const task = workspaceClient.json<ChatDefaultsResponse>("/api/settings/chat-defaults")
    .then(({ defaults, availability }) => {
      // Creation may have finished while this preview request was in flight.
      if (bindings.has(key)) return;
      const current = stateFor(key);
      putState(key, {
        ...current,
        settings: { ...UNSELECTED_THREAD_SETTINGS, ...defaults.selection, ...current.pendingPatch },
        settingsLoaded: true,
        loading: false,
        error: current.pendingPatch ? current.error : availability.status === "unavailable"
          ? availability.reason ?? agentText("默认模型已不可用，请显式选择另一个模型。", "The default model is unavailable; choose another model explicitly.") : undefined,
      });
    })
    .catch((error: unknown) => {
      if (!bindings.has(key)) putState(key, { ...stateFor(key), loading: false, error: message(error) });
      throw error;
    })
    .finally(() => { if (loads.get(key) === task) loads.delete(key); });
  loads.set(key, task);
  return task;
}
export function refreshNewChatDefaults(): void {
  for (const key of states.keys()) {
    if (key.startsWith(DRAFT_PREFIX) && !bindings.has(key))
      void (loads.get(key) ?? Promise.resolve()).catch(() => {})
        .then(() => loadNewSettings(key, true)).catch(() => {});
  }
}
function acceptSavedSettings(id: string, thread: RemoteThread, written: RemoteSettings): void {
  const pendingPatch = pendingRemoteSettings(stateFor(id).pendingPatch, remoteSettingsKeys, written);
  putState(id, {
    ...stateFor(id), settings: { ...thread.settings, ...pendingPatch }, revision: thread.revision,
    settingsLoaded: true, loading: false, error: undefined, pendingPatch,
  });
  acceptRemoteThread(thread);
}
async function savePendingSettings(id: string): Promise<void> {
  const prior = queues.get(id) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    await loadThreadSettings(id);
    const current = stateFor(id);
    if (!current.pendingPatch) return;
    const written = threadSettingsSchema.parse(current.settings);
    const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(
      `/api/chat/threads/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ settings: written, revision: current.revision }) },
    );
    const latestRevision = stateFor(id).revision;
    if (latestRevision !== undefined && thread.revision < latestRevision)
      throw new Error(agentText("会话设置已更新，请重试以读取最新版本。", "Session settings changed; retry to load the latest revision."));
    acceptSavedSettings(id, thread, written);
  }).catch((error: unknown) => {
    putState(id, { ...stateFor(id), error: message(error) });
    throw error;
  }).finally(() => {
    if (queues.get(id) === task) {
      queues.delete(id);
      putState(id, { ...stateFor(id), saving: false });
    }
  });
  queues.set(id, task);
  return task;
}
export async function flushThreadSettings(id: string): Promise<SettingsState> {
  await queues.get(id);
  await loadThreadSettings(id);
  const state = stateFor(id);
  if (state.error) throw new Error(state.error);
  if (state.pendingPatch || state.saving) throw new Error(agentText("会话设置尚未保存，请重试保存。", "Session settings are not saved; retry the save."));
  if (!state.ready) throw new Error(agentText("请先为此会话选择并保存模型提供商和模型。", "Select and save a model provider and model for this session first."));
  return state;
}
function loadVoice(): void {
  if (voiceLoaded) return;
  voiceLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<ChatSettings>;
    voice = { dictation: saved.dictation === true, speak: saved.speak === true };
  } catch { /* Voice preferences remain available in memory. */ }
}
export function useVoiceSettings() {
  loadVoice();
  return useSyncExternalStore(subscribe, () => voice, () => voice);
}
/** draftId keeps uninitialized conversations isolated without creating a thread to open settings. */
export function useChatSettings(threadId?: string, initialize?: () => Promise<string>, draftId = "new") {
  const key = threadId ?? `${DRAFT_PREFIX}${draftId}`;
  const state = useSyncExternalStore(subscribe, () => stateFor(key), () => SERVER_STATE);
  useEffect(() => {
    void (threadId ? loadThreadSettings(threadId) : loadNewSettings(key, true)).catch(() => {});
  }, [threadId, key]);
  const setSettings = useCallback(async (patch: Partial<RemoteSettings>): Promise<void> => {
    patch = pendingRemoteSettings(patch, remoteSettingsKeys) ?? {};
    const before = stateFor(key);
    if ((patch.providerInstanceId !== undefined && patch.providerInstanceId !== before.settings.providerInstanceId) ||
        (patch.model !== undefined && patch.model !== before.settings.model)) {
      patch = { modelOptions: [], ...patch };
    }
    putState(key, {
      ...before, settings: { ...before.settings, ...patch },
      pendingPatch: { ...before.pendingPatch, ...patch }, saving: true, error: undefined,
    });
    try {
      let id = threadId ?? bindings.get(key);
      if (!id) {
        if (!initialize) throw new Error(agentText("无法建立会话来保存模型设置，请先选择工作区或项目。", "Cannot create a session to save model settings; choose a workspace or project first."));
        let initializing = initializations.get(key);
        if (!initializing) {
          initializing = initialize();
          initializations.set(key, initializing);
        }
        try { id = await initializing; }
        finally { if (initializations.get(key) === initializing) initializations.delete(key); }
        const draft = stateFor(key);
        bindings.set(key, id);
        const saved = stateFor(id);
        putState(id, {
          ...saved, settings: { ...saved.settings, ...draft.pendingPatch },
          pendingPatch: { ...saved.pendingPatch, ...draft.pendingPatch }, saving: true, error: undefined,
        });
        states.delete(key);
      }
      await savePendingSettings(id);
    } catch (error) {
      putState(key, { ...stateFor(key), saving: false, error: message(error) });
      throw error;
    }
  }, [threadId, key, initialize]);
  const set = useCallback<SettingsUpdater>((keyOrPatch: keyof ChatSettings | Partial<RemoteSettings>, value?: ChatSettings[keyof ChatSettings]) => {
    if (keyOrPatch === "dictation" || keyOrPatch === "speak") {
      voice = { ...voice, [keyOrPatch]: value === true };
      try {
        const previous = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<ChatSettings>;
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...previous, ...voice }));
      } catch { /* Keep the migration backup and in-memory preference. */ }
      notifySettings();
      return;
    }
    const patch = typeof keyOrPatch === "object" ? keyOrPatch : { [keyOrPatch]: value };
    void setSettings(patch as Partial<RemoteSettings>).catch(() => {});
  }, [setSettings]);
  const retry = useCallback(async () => {
    const id = threadId ?? bindings.get(key);
    if (!id) {
      if (stateFor(key).pendingPatch) return setSettings({});
      return loadNewSettings(key, true);
    }
    await queues.get(id)?.catch(() => {});
    await loadThreadSettings(id, true);
    if (stateFor(id).pendingPatch) {
      putState(id, { ...stateFor(id), saving: true, error: undefined });
      await savePendingSettings(id);
    }
  }, [threadId, key, setSettings]);
  return {
    settings: state.settings, set, setSettings,
    ready: state.ready, settingsLoaded: state.settingsLoaded, loading: state.loading,
    saving: state.saving, error: state.error, retry,
  };
}
