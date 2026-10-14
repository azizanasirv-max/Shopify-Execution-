import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createSession as apiCreateSession, endSession as apiEndSession } from "./api";
import { CallRecord, CallRegistry, CallStatus } from "./sessionRegistry";
import { buildInviteUrl } from "./invite";

/**
 * Active-session + call-history state for the salesperson dashboard.
 *
 * SECURITY
 * - Session authorization tokens and invitation tokens live ONLY in memory
 *   (refs), for the lifetime of the tab. They are never written to
 *   localStorage/sessionStorage, cookies, or logs.
 * - The invitation URL is derived in memory so the salesperson can copy/share
 *   it; it contains only the scoped invitation token.
 */
export interface ActiveSession {
  sessionId: string;
  productId: string;
  roomName: string;
  createdAt: number;
  status: CallStatus;
  inviteUrl: string | null;
}

interface SessionContextValue {
  activeSession: ActiveSession | null;
  calls: CallRecord[];
  starting: boolean;
  startSession: (productId: string) => Promise<ActiveSession>;
  setStatus: (sessionId: string, status: CallStatus) => void;
  activateCall: (sessionId: string) => void;
  endActiveSession: () => Promise<void>;
  getSessionToken: (sessionId: string) => string | undefined;
  getInviteUrl: (sessionId: string) => string | null;
  removeCall: (sessionId: string) => void;
  clearHistory: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const registryRef = useRef<CallRegistry>(new CallRegistry());
  const sessionTokensRef = useRef<Map<string, string>>(new Map());
  const inviteTokensRef = useRef<Map<string, string>>(new Map());

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [starting, setStarting] = useState(false);

  const syncCalls = useCallback(() => {
    setCalls(registryRef.current.list());
  }, []);

  const buildInvite = useCallback((sessionId: string, productId: string): string | null => {
    const inviteToken = inviteTokensRef.current.get(sessionId);
    if (!inviteToken || typeof window === "undefined") return null;
    try {
      return buildInviteUrl(window.location.origin, window.location.pathname, sessionId, inviteToken);
    } catch {
      return null;
    }
  }, []);

  const startSession = useCallback(
    async (productId: string): Promise<ActiveSession> => {
      setStarting(true);
      try {
        const created = await apiCreateSession(productId);

        // Keep secrets in memory only.
        sessionTokensRef.current.set(created.sessionId, created.sessionToken);
        if (created.inviteToken) inviteTokensRef.current.set(created.sessionId, created.inviteToken);

        registryRef.current.upsert({
          sessionId: created.sessionId,
          productId: created.productId,
          roomName: created.roomName,
          createdAt: created.createdAt || Date.now(),
          status: "created",
        });
        syncCalls();

        const session: ActiveSession = {
          sessionId: created.sessionId,
          productId: created.productId,
          roomName: created.roomName,
          createdAt: created.createdAt || Date.now(),
          status: "created",
          inviteUrl: buildInvite(created.sessionId, created.productId),
        };
        setActiveSession(session);
        return session;
      } finally {
        setStarting(false);
      }
    },
    [buildInvite, syncCalls]
  );

  const setStatus = useCallback(
    (sessionId: string, status: CallStatus) => {
      registryRef.current.setStatus(sessionId, status);
      syncCalls();
      setActiveSession((prev) => (prev && prev.sessionId === sessionId ? { ...prev, status } : prev));
    },
    [syncCalls]
  );

  /** Make an existing call record the active session (used from Call History). */
  const activateCall = useCallback(
    (sessionId: string) => {
      const record = registryRef.current.get(sessionId);
      if (!record) return;
      setActiveSession({
        sessionId: record.sessionId,
        productId: record.productId,
        roomName: record.roomName ?? "",
        createdAt: record.createdAt,
        status: record.status,
        inviteUrl: buildInvite(sessionId, record.productId),
      });
    },
    [buildInvite]
  );

  const endActiveSession = useCallback(async () => {
    const current = activeSession;
    if (!current) return;
    const token = sessionTokensRef.current.get(current.sessionId);
    setStatus(current.sessionId, "ended");
    setActiveSession((prev) => (prev ? { ...prev, status: "ended" } : prev));
    if (token) {
      try {
        await apiEndSession(current.sessionId, token);
      } catch {
        /* best effort — the session may already have expired */
      }
    }
  }, [activeSession, setStatus]);

  const getSessionToken = useCallback((sessionId: string) => sessionTokensRef.current.get(sessionId), []);
  const getInviteUrl = useCallback(
    (sessionId: string) => {
      const record = registryRef.current.get(sessionId);
      return buildInvite(sessionId, record?.productId ?? "");
    },
    [buildInvite]
  );

  const removeCall = useCallback(
    (sessionId: string) => {
      registryRef.current.remove(sessionId);
      sessionTokensRef.current.delete(sessionId);
      inviteTokensRef.current.delete(sessionId);
      syncCalls();
      setActiveSession((prev) => (prev && prev.sessionId === sessionId ? null : prev));
    },
    [syncCalls]
  );

  const clearHistory = useCallback(() => {
    registryRef.current.clear();
    syncCalls();
  }, [syncCalls]);

  const value = useMemo<SessionContextValue>(
    () => ({
      activeSession,
      calls,
      starting,
      startSession,
      setStatus,
      activateCall,
      endActiveSession,
      getSessionToken,
      getInviteUrl,
      removeCall,
      clearHistory,
    }),
    [
      activeSession,
      calls,
      starting,
      startSession,
      setStatus,
      activateCall,
      endActiveSession,
      getSessionToken,
      getInviteUrl,
      removeCall,
      clearHistory,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside a <SessionProvider>.");
  return ctx;
}
