import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { body, BodyError, MAX_BODY_BYTES } from "./body.ts";
import type { Clock } from "./clock.ts";
import { createConnection } from "./connections.ts";
import type { SocialProvider } from "./provider.ts";
import { DEFAULT_SYNC_OPTIONS, latestPosts, syncConnection, syncRuns } from "./sync.ts";
import type { SyncOptions } from "./sync.ts";

export function createApp(deps: {
  db: DatabaseSync;
  provider: SocialProvider;
  clock: Clock;
  options?: Partial<SyncOptions>;
}) {
  const { db, provider, clock } = deps;
  const options: SyncOptions = { ...DEFAULT_SYNC_OPTIONS, ...deps.options };
  const app = new Hono();

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "corpo acima de 64 KB" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof BodyError) return c.json(error.payload, error.status);
    // Erro inesperado: 500 em JSON genérico, sem stack na resposta; o detalhe vai para o log.
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.post("/connections", async (c) => {
    const outcome = createConnection(db, await body(c, ["platform", "creator_id"]));
    return c.json(outcome.body, outcome.status);
  });

  app.post("/connections/:id/sync", async (c) => {
    const outcome = await syncConnection(db, provider, clock, c.req.param("id"), options);
    return c.json(outcome.body, outcome.status);
  });

  app.get("/connections/:id/posts", (c) => {
    const id = c.req.param("id");
    const exists = db.prepare("SELECT 1 FROM connections WHERE id = ?").get(id);
    if (!exists) return c.json({ error: "conexão não encontrada" }, 404);
    const posts = latestPosts(db, id);
    return c.json({
      connection_id: id,
      total_views: posts.reduce((sum, post) => sum + post.views, 0),
      posts,
    });
  });

  app.get("/connections/:id/syncs", (c) => {
    const id = c.req.param("id");
    if (!db.prepare("SELECT 1 FROM connections WHERE id = ?").get(id)) return c.json({ error: "conexão não encontrada" }, 404);
    return c.json({ connection_id: id, syncs: syncRuns(db, id) });
  });

  return app;
}
