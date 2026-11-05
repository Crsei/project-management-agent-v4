import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsApi, type ManagementSettings } from "../lib/api/settings";
import { toast } from "../lib/toast";

/** Only the existing storage/sync controls are mounted; provider/account settings stay host-owned. */
export function useSettingsQuery() {
  return useQuery({ queryKey: ["settings"], queryFn: () => settingsApi.get() });
}
export function useSettings() {
  const query = useSettingsQuery();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async (updates: Partial<ManagementSettings>) => {
      const settings = client.getQueryData<ManagementSettings>(["settings"]);
      if (!settings) throw new Error("Settings have not loaded.");
      const next = { ...settings, ...updates };
      const saved = await settingsApi.save({ skillSyncMethod: next.skillSyncMethod, backupRetainCount: next.backupRetainCount, language: next.language, visibleApps: next.visibleApps });
      if (!saved) throw new Error("The host did not save the storage settings.");
      return updates;
    },
    onError: (cause) => toast.error("无法保存 Skills 存储设置", { description: cause instanceof Error ? cause.message : String(cause), closeButton: true }),
    onSettled: () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const updateSettings = useCallback((updates: Partial<ManagementSettings>) => {
    client.setQueryData<ManagementSettings>(["settings"], (current) => current ? { ...current, ...updates } : current);
  }, [client]);
  return { settings: query.data, isLoading: query.isLoading, error: query.error, refetch: query.refetch, updateSettings, autoSaveSettings: save.mutateAsync };
}
