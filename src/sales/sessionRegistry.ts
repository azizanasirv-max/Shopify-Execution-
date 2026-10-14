/**
 * In-memory call registry for the salesperson's browser tab.
 *
 * SECURITY: this registry stores ONLY non-secret session metadata (id, product,
 * room, timestamps, status). Session authorization tokens and invitation tokens
 * are deliberately excluded so they can never be serialized, logged, or placed
 * in persistent browser storage.
 */

export type CallStatus = "created" | "live" | "ended";

export interface CallRecord {
  sessionId: string;
  productId: string;
  roomName?: string;
  createdAt: number;
  status: CallStatus;
  lastActivityAt?: number;
}

export class CallRegistry {
  private records = new Map<string, CallRecord>();

  /** Insert or update a call record. Returns the stored record. */
  public upsert(record: CallRecord): CallRecord {
    if (!record.sessionId) throw new Error("A call record requires a sessionId.");
    const existing = this.records.get(record.sessionId);
    const next: CallRecord = existing
      ? { ...existing, ...record, createdAt: existing.createdAt }
      : { ...record };
    this.records.set(next.sessionId, next);
    return next;
  }

  public setStatus(sessionId: string, status: CallStatus): CallRecord | undefined {
    const existing = this.records.get(sessionId);
    if (!existing) return undefined;
    const next: CallRecord = { ...existing, status, lastActivityAt: Date.now() };
    this.records.set(sessionId, next);
    return next;
  }

  public get(sessionId: string): CallRecord | undefined {
    return this.records.get(sessionId);
  }

  public remove(sessionId: string): boolean {
    return this.records.delete(sessionId);
  }

  /** Newest first. */
  public list(): CallRecord[] {
    return Array.from(this.records.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public clear(): void {
    this.records.clear();
  }

  public get size(): number {
    return this.records.size;
  }
}
