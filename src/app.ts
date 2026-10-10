import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Clock } from "./clock.ts";
import { createConnection } from "./connections.ts";
import type { SocialProvider } from "./provider.ts";
import { DEFAULT_SYNC_OPTIONS, latestPosts, syncConnection } from "./sync.ts";
import type { SyncOptions } from "./sync.ts";

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export function createApp(deps: {
  db: DatabaseSync;
  provider: SocialProvider;
  clock: Clock;
  options?: Partial<SyncOptions>;
}) {
  const { db, provider, clock } = deps;
  const options: SyncOptions = { ...DEFAULT_SYNC_OPTIONS, ...deps.options };
  const app = new Hono();

  app.post("/connections", async (c) => {
    const outcome = createConnection(db, await body(c));
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

  return app;
}
