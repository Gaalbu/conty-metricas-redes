import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { ProviderFailure } from "./provider.ts";
import type { Connection, PostSnapshot, SocialProvider } from "./provider.ts";

export type SyncOptions = { maxAttempts: number; maxWaitSeconds: number };
export const DEFAULT_SYNC_OPTIONS: SyncOptions = { maxAttempts: 4, maxWaitSeconds: 30 };

export type SyncOutcome =
  | { status: 200; body: { connection_id: string; attempts: number; inserted: number; duplicates: number } }
  | { status: 404; body: { error: string } }
  | { status: 503; body: { error: string; attempts: number; last_failure: string } };

// Espera antes da próxima tentativa. 429 respeita o Retry-After; timeout e
// indisponibilidade dobram a cada tentativa. As duas ficam abaixo do teto.
export function waitSeconds(failure: ProviderFailure, attempt: number, maxWaitSeconds: number): number {
  if (failure.kind === "rate_limited" && failure.retryAfterSeconds !== undefined) {
    return Math.min(Math.max(0, failure.retryAfterSeconds), maxWaitSeconds);
  }
  return Math.min(2 ** (attempt - 1), maxWaitSeconds);
}

function store(db: DatabaseSync, connectionId: string, posts: PostSnapshot[], fetchedAt: string) {
  // A chave única (connection_id, external_id, captured_at) é quem garante que
  // a mesma janela não entra duas vezes; ON CONFLICT só evita o erro.
  const insert = db.prepare(
    `INSERT INTO post_snapshots (connection_id, external_id, views, captured_at, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, external_id, captured_at) DO NOTHING`,
  );
  let inserted = 0;
  let duplicates = 0;
  db.exec("BEGIN");
  try {
    for (const post of posts) {
      const result = insert.run(connectionId, post.external_id, post.views, post.captured_at, fetchedAt);
      if (Number(result.changes) === 1) inserted += 1;
      else duplicates += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { inserted, duplicates };
}

export async function syncConnection(
  db: DatabaseSync,
  provider: SocialProvider,
  clock: Clock,
  connectionId: string,
  options: SyncOptions = DEFAULT_SYNC_OPTIONS,
): Promise<SyncOutcome> {
  const connection = db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId) as
    | Connection
    | undefined;
  if (!connection) return { status: 404, body: { error: "conexão não encontrada" } };

  let lastFailure = "unavailable";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const posts = await provider.listPosts(connection);
      const counts = store(db, connectionId, posts, clock.now().toISOString());
      return { status: 200, body: { connection_id: connectionId, attempts: attempt, ...counts } };
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;
      lastFailure = error.kind;
      if (attempt === options.maxAttempts) break;
      await clock.wait(waitSeconds(error, attempt, options.maxWaitSeconds));
    }
  }

  return {
    status: 503,
    body: { error: "provedor indisponível", attempts: options.maxAttempts, last_failure: lastFailure },
  };
}

export type LatestPost = { external_id: string; views: number; captured_at: string; fetched_at: string };

// Cada post vale pela janela mais recente, nunca pela soma das janelas.
export function latestPosts(db: DatabaseSync, connectionId: string): LatestPost[] {
  return db
    .prepare(
      `SELECT external_id, views, captured_at, fetched_at
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY external_id ORDER BY captured_at DESC, id DESC
         ) AS rn
         FROM post_snapshots
         WHERE connection_id = ?
       )
       WHERE rn = 1
       ORDER BY external_id ASC`,
    )
    .all(connectionId) as LatestPost[];
}
