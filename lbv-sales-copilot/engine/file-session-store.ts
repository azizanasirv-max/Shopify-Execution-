import { SalesSession, ConversationTurn } from "./types.js";
import { SessionStore } from "./session-manager.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Durable single-instance file-based JSON session store.
 * Note: Restricted to a single server instance using a persistent filesystem.
 * Its mutex provides single-process thread isolation but does not provide cross-process
 * or multi-instance locking/consistency. Persistence errors are strictly propagated to callers.
 */
export class FileSessionStore implements SessionStore {
  private filePath: string;
  private memoryStore = new Map<string, SalesSession>();

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.env.LBV_SESSION_FILE_PATH || "./data/sessions.json");
    this.load();
  }

  private checkWritable(dir: string): void {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const testFile = path.join(dir, `.test-write-${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(testFile, "ok", "utf-8");
      fs.unlinkSync(testFile);
    } catch (err: any) {
      throw new Error(`[FileSessionStore] Directory ${dir} is not writable or accessible: ${err.message}`);
    }
  }

  private load(): void {
    const dir = path.dirname(this.filePath);
    this.checkWritable(dir);
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.memoryStore.clear();
          for (const session of data) {
            if (session && session.id) {
              this.memoryStore.set(session.id, session);
            }
          }
        }
      } catch (err: any) {
        throw new Error(`[FileSessionStore] Failed to load or parse sessions from ${this.filePath}: ${err.message}`);
      }
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    this.checkWritable(dir);
    const data = Array.from(this.memoryStore.values());
    const tempPath = `${this.filePath}.tmp.${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw new Error(`[FileSessionStore] Failed to atomically persist sessions to ${this.filePath}: ${err.message}`);
    }
  }

  get(sessionId: string): SalesSession | undefined {
    return this.memoryStore.get(sessionId);
  }

  set(sessionId: string, session: SalesSession): void {
    this.memoryStore.set(sessionId, session);
    this.persist();
  }

  delete(sessionId: string): boolean {
    const deleted = this.memoryStore.delete(sessionId);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  values(): SalesSession[] {
    return Array.from(this.memoryStore.values());
  }

  clear(): void {
    this.memoryStore.clear();
    this.persist();
  }

  size(): number {
    return this.memoryStore.size;
  }
}
