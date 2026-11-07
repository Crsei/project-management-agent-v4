import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { workspaceClient } from "./network";
import { useAgentText } from "./i18n";
import { agentText } from "./i18n-text.ts";
import { setApprovalMode } from "./runtime-config.ts";

export function AccessGate({ children }: { children: ReactNode }) {
  const t = useAgentText();
  const [authorized, setAuthorized] = useState(false);
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    workspaceClient
      .json<{ authorized: boolean; configured: boolean; approvalMode?: string; message?: string | null }>("/api/access", {
        signal: controller.signal,
      })
      .then((result) => {
        setApprovalMode(result.approvalMode);
        setAuthorized(result.authorized === true);
        setConfigured(result.configured === true);
        setError(result.message ?? null);
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : agentText("无法连接工作区服务。", "Could not connect to the workspace service."));
        setReady(true);
      });
    return () => controller.abort();
  }, []);

  if (authorized) return children;
  if (!ready)
    return (
      <p role="status" className="p-8">
        {t("正在连接工作区…", "Connecting to workspace…")}
      </p>
    );
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
      <h1 className="text-xl font-semibold">{t("工作区访问验证", "Workspace access")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("请输入服务管理员提供的访问令牌。", "Enter the access token provided by the service administrator.")}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            await workspaceClient.json("/api/access", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            });
            setToken("");
            setAuthorized(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : agentText("访问验证失败。", "Access verification failed."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="text-sm" htmlFor="workspace-access-token">
          {t("访问令牌", "Access token")}
        </label>
        <Input
          id="workspace-access-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={!configured || busy}
        />
        <Button type="submit" disabled={!configured || !token || busy}>
          {busy ? t("正在验证…", "Verifying…") : t("打开工作区", "Open workspace")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!configured && (
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("重新连接", "Reconnect")}
        </Button>
      )}
    </main>
  );
}
