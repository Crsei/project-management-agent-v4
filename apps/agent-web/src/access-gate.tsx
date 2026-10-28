import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { workspaceClient } from "./network";

export function AccessGate({ children }: { children: ReactNode }) {
  const [authorized, setAuthorized] = useState(false);
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    workspaceClient
      .json<{ authorized: boolean; configured: boolean; message?: string | null }>("/api/access", {
        signal: controller.signal,
      })
      .then((result) => {
        setAuthorized(result.authorized === true);
        setConfigured(result.configured === true);
        setError(result.message ?? null);
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "无法连接工作区服务。");
        setReady(true);
      });
    return () => controller.abort();
  }, []);

  if (authorized) return children;
  if (!ready)
    return (
      <p role="status" className="p-8">
        正在连接工作区…
      </p>
    );
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
      <h1 className="text-xl font-semibold">工作区访问验证</h1>
      <p className="text-sm text-muted-foreground">
        此服务可以执行本机任务。请输入服务管理员提供的访问令牌；令牌不会写入浏览器本地存储。
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
            setError(cause instanceof Error ? cause.message : "访问验证失败。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="text-sm" htmlFor="workspace-access-token">
          访问令牌
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
          {busy ? "正在验证…" : "打开工作区"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!configured && (
        <Button variant="outline" onClick={() => window.location.reload()}>
          重新连接
        </Button>
      )}
    </main>
  );
}
