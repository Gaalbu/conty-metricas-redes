import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PLATFORMS } from "./provider.ts";
import type { Platform } from "./provider.ts";

export type CreateOutcome =
  | { status: 201; body: { id: string; platform: Platform; creator_id: string } }
  | { status: 400; body: { error: string } };

export function createConnection(
  db: DatabaseSync,
  input: { platform?: unknown; creator_id?: unknown },
): CreateOutcome {
  const platform = PLATFORMS.find((p) => p === input.platform);
  if (!platform) return { status: 400, body: { error: "plataforma desconhecida" } };
  const creatorId = typeof input.creator_id === "string" ? input.creator_id.trim() : "";
  if (!creatorId) return { status: 400, body: { error: "creator_id é obrigatório" } };

  const id = `con_${randomUUID()}`;
  // Token fictício: a integração real trocaria isto por OAuth.
  db.prepare("INSERT INTO connections (id, platform, creator_id, token) VALUES (?, ?, ?, ?)").run(
    id,
    platform,
    creatorId,
    `demo_${randomUUID()}`,
  );
  return { status: 201, body: { id, platform, creator_id: creatorId } };
}
