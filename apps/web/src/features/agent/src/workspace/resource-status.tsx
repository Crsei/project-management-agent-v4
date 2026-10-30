import { useState } from "react";
import { Button } from "@agent/components/ui/button";
import { errorMessage } from "./api";
import { useWorkspace } from "./provider";

export function ResourceSyncStatus() {
  const {
    ready,
    threadId,
    state,
    resourceStatus,
    resourceError,
    retrySave,
    reloadResources,
    resolveConflict,
  } = useWorkspace();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function perform(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  if (!threadId) return null;
  return (
    <section className="live-resource-sync" aria-label="资源保存状态">
      <p role="status" className="live-panel-status">
        {resourceStatus === "loading"
          ? "正在读取会话资源…"
          : resourceStatus === "saving"
            ? "正在保存资源到服务端…"
            : resourceStatus === "saved"
              ? `资源已保存 · revision ${state.revision}`
              : resourceStatus === "conflict"
                ? "资源版本冲突 · 本地草稿保留"
                : "资源尚未保存 · 本地草稿保留"}
      </p>
      {(resourceError || error) && (
        <p className="live-panel-error" role="alert">
          {error ?? resourceError}
        </p>
      )}
      {resourceStatus === "conflict" ? (
        <div className="live-panel-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  "用当前完整资源草稿替换服务端最新资源？其他页面的资源修改将被替换，服务端运行记录不受影响。",
                )
              )
                void perform(resolveConflict);
            }}
          >
            确认用我的草稿保存
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("放弃此会话未保存的资源草稿，重新读取服务端最新版本？"))
                void perform(reloadResources);
            }}
          >
            放弃草稿并载入服务器版本
          </Button>
        </div>
      ) : resourceStatus === "unsaved" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void perform(retrySave)}
        >
          重试保存资源
        </Button>
      ) : !ready && threadId ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void perform(reloadResources)}
        >
          重试读取 / 迁移
        </Button>
      ) : null}
    </section>
  );
}
