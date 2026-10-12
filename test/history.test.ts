import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { ProviderFailure } from "../src/provider.ts";
import type { PostSnapshot, SocialProvider } from "../src/provider.ts";
import { FakeClock, ScriptedProvider } from "./support.ts";

const P1: PostSnapshot = { external_id: "p1", views: 10, captured_at: "2026-06-01T10:00:00.000Z" };

async function setup(provider: SocialProvider, clock = new FakeClock("2026-06-02T12:00:00.000Z")) {
  const app = createApp({ db: openDatabase(), provider, clock, options: { maxAttempts: 2, maxWaitSeconds: 30 } });
  const res = await app.request("/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "tiktok", creator_id: "crt_ana" }) });
  const { id } = (await res.json()) as { id: string };
  return { app, id, clock, sync: () => app.request(`/connections/${id}/sync`, { method: "POST" }) };
}

describe("histórico do sync e quando a métrica foi buscada", () => {
  it("fetched_at é a primeira busca do snapshot e last_fetched_at a mais recente", async () => {
    const { app, id, sync, clock } = await setup(new ScriptedProvider([[P1], [P1]]));
    await sync();
    clock.advance(7200);
    await sync();
    const body = (await (await app.request(`/connections/${id}/posts`)).json()) as { posts: Array<Record<string, unknown>> };
    expect(body.posts[0]).toMatchObject({ fetched_at: "2026-06-02T12:00:00.000Z", last_fetched_at: "2026-06-02T14:00:00.000Z" });
  });
});
