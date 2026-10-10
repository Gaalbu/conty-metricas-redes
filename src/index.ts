import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import type { SocialProvider } from "./provider.ts";
import { DEFAULT_SYNC_OPTIONS } from "./sync.ts";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Demo: um post fixo, sem rede social de verdade.
const demoProvider: SocialProvider = {
  async listPosts() {
    return [{ external_id: "demo_post_1", views: 1200, captured_at: "2026-06-01T12:00:00.000Z" }];
  },
};

const options = {
  maxAttempts: positiveInt(process.env.MAX_ATTEMPTS, DEFAULT_SYNC_OPTIONS.maxAttempts),
  maxWaitSeconds: positiveInt(process.env.MAX_WAIT_SECONDS, DEFAULT_SYNC_OPTIONS.maxWaitSeconds),
  attemptTimeoutSeconds: positiveInt(process.env.ATTEMPT_TIMEOUT_SECONDS, DEFAULT_SYNC_OPTIONS.attemptTimeoutSeconds),
};
const port = Number(process.env.PORT ?? 43122);
const app = createApp({ db: openDatabase(), provider: demoProvider, clock: systemClock, options });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});
