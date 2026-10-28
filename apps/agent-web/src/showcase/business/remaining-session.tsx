"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
const Session = createContext<{
  caches: Map<string, Map<string, unknown>>;
  reset: (key: string) => void;
} | null>(null);
export function RemainingSession({ children }: { children: ReactNode }) {
  const [caches] = useState(() => new Map<string, Map<string, unknown>>());
  return (
    <Session.Provider
      value={{
        caches,
        reset: (key) => {
          caches.delete(key);
        },
      }}
    >
      {children}
    </Session.Provider>
  );
}
export function useRemainingSession() {
  const session = useContext(Session);
  if (!session) throw new Error("Remaining pages require their Lab session");
  return session;
}
