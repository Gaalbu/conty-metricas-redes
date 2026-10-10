import { DatabaseSync } from "node:sqlite";
import { canonicalInstant } from "./snapshot.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'x')),
  creator_id TEXT NOT NULL,
  token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  external_id TEXT NOT NULL,
  views INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (connection_id, external_id, captured_at)
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  canonicalizeLegacyCaptures(db);
  return db;
}

// Bancos gravados antes da normalização guardam captured_at como o provedor
// mandou. Cada linha passa para ISO UTC; se isso colidir com uma captura já
// canônica, a linha fica como está e o aviso pede reconciliação. Nada é apagado.
function canonicalizeLegacyCaptures(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, captured_at FROM post_snapshots").all() as Array<{ id: number; captured_at: string }>;
  const update = db.prepare("UPDATE post_snapshots SET captured_at = ? WHERE id = ?");
  const kept: number[] = [];
  for (const row of rows) {
    const canonical = canonicalInstant(row.captured_at);
    if (!canonical || canonical === row.captured_at) continue;
    try {
      update.run(canonical, row.id);
    } catch {
      kept.push(row.id);
    }
  }
  if (kept.length > 0) {
    console.warn(
      `[métricas] ${kept.length} captura(s) antiga(s) equivalem a outra já salva e não foram normalizadas (ids ${kept.join(", ")}). Reconcilie antes de removê-las.`,
    );
  }
}
