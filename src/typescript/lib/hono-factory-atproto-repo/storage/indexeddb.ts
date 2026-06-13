// @publicdomainrelay/hono-factory-atproto-repo — IndexedDB storage backend
//
// Browser IndexedDB backend behind the Storage interface.
// Two object stores: "blocks" (keyPath: cid) and "heads" (keyPath: did).
// Guarded with `typeof indexedDB !== "undefined"` for tree-shaking in non-browser bundles.

import type { Storage, Cid, Did, Tid, Bytes } from "../contracts.ts";

const DB_NAME = "atproto-repo";
const DB_VERSION = 1;

export class IndexedDbStorage implements Storage {
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async create(): Promise<IndexedDbStorage> {
    if (typeof indexedDB === "undefined") {
      throw new Error(
        "IndexedDbStorage: indexedDB is not available in this environment",
      );
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("blocks")) {
          db.createObjectStore("blocks", { keyPath: "cid" });
        }
        if (!db.objectStoreNames.contains("heads")) {
          db.createObjectStore("heads", { keyPath: "did" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IndexedDbStorage(db);
  }

  async get(cid: Cid): Promise<Bytes | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("blocks", "readonly");
      const store = tx.objectStore("blocks");
      const req = store.get(cid);
      req.onsuccess = () => resolve((req.result as { cid: Cid; bytes: Bytes } | undefined)?.bytes ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(cid: Cid, bytes: Bytes): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("blocks", "readwrite");
      const store = tx.objectStore("blocks");
      store.put({ cid, bytes });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async has(cid: Cid): Promise<boolean> {
    const bytes = await this.get(cid);
    return bytes !== null;
  }

  async getHead(did: Did): Promise<{ commit: Cid; rev: Tid } | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("heads", "readonly");
      const store = tx.objectStore("heads");
      const req = store.get(did);
      req.onsuccess = () =>
        resolve((req.result as { did: Did; head: { commit: Cid; rev: Tid } } | undefined)?.head ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async setHead(did: Did, head: { commit: Cid; rev: Tid }): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("heads", "readwrite");
      const store = tx.objectStore("heads");
      store.put({ did, head });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
