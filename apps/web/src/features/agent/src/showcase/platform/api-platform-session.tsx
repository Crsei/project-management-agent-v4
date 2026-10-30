"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { ApCache } from "@easyuse-ui/agent-workspace-views/api-platform/state";
const Session = createContext<{
  caches: Map<string, ApCache>;
  version: number;
  reset: (key: string) => void;
} | null>(null);
export function ApiPlatformSession({ children }: { children: ReactNode }) {
  const [caches] = useState(() => new Map<string, ApCache>()),
    [version, setVersion] = useState(0);
  return (
    <Session.Provider
      value={{
        caches,
        version,
        reset: (key) => {
          caches.delete(key);
          setVersion((v) => v + 1);
        },
      }}
    >
      {children}
    </Session.Provider>
  );
}
export function useApiPlatformSession(key: string) {
  const session = useContext(Session);
  if (!session) throw new Error("API Platform requires its Lab session");
  if (!session.caches.has(key)) session.caches.set(key, new Map());
  return { ...session, cache: session.caches.get(key)! };
}
