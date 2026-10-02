// Imported workbench site files, kept in this browser (IndexedDB) so interval data survives reloads
// without bloating localStorage or share links. Sites reference a record by `interval_id`.
import { decodeRaw, buildInterval } from './workbench.js';

const DB = 'atlas';
const STORE = 'workbench_sites';
const records = new Map(); // id -> { id, file_name, imported_at, model (without raw), raw }
const built = new Map(); // id -> buildInterval result
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const intervalStore = {
  /** Load saved records into memory. Never throws: without IndexedDB, imports last for the session. */
  async init() {
    try {
      db = await openDb();
      const all = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      all.forEach((r) => records.set(r.id, r));
    } catch {
      db = null;
    }
  },
  get(id) {
    return id ? records.get(id) || null : null;
  },
  /** Per-month interval data for the engine, built once per record. */
  intervalFor(id) {
    if (!id || !records.has(id)) return null;
    if (!built.has(id)) built.set(id, buildInterval(decodeRaw(records.get(id).raw)));
    return built.get(id);
  },
  put(rec) {
    records.set(rec.id, rec);
    built.delete(rec.id);
    if (!db) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  },
  remove(id) {
    records.delete(id);
    built.delete(id);
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    } catch {
      /* ignore */
    }
  },
  /** True when imports persist across reloads in this browser. */
  get persistent() {
    return !!db;
  },
};

/** Stable id for an imported file: same site + same data → same id (re-imports replace). */
export function recordId(model) {
  const r = model?.raw || {};
  const key = `${model?.meta?.site || ''}|${r.n || 0}|${r.b || 0}|${r.dt || 0}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `wb-${(h >>> 0).toString(36)}`;
}
