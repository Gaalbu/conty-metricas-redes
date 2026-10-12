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
  it("cada sync fica registrado com início, fim, tentativas, contagens e resultado", async () => {
    const { app, id, sync, clock } = await setup(new ScriptedProvider([[P1], new ProviderFailure("timeout")]));
    await sync();
    clock.advance(3600);
    await sync();
    const body = (await (await app.request(`/connections/${id}/syncs`)).json()) as { syncs: Array<Record<string, unknown>> };
    expect(body.syncs).toEqual([
      expect.objectContaining({ status: 200, attempts: 1, inserted: 1, duplicates: 0, started_at: "2026-06-02T12:00:00.000Z", finished_at: "2026-06-02T12:00:00.000Z", error: null }),
      expect.objectContaining({ status: 503, attempts: 2, inserted: 0, duplicates: 0, started_at: "2026-06-02T13:00:00.000Z", finished_at: "2026-06-02T13:00:01.000Z", error: "provedor indisponível" }),
    ]);
  });
  it("fetched_at é a primeira busca do snapshot e last_fetched_at a mais recente", async () => {
    const { app, id, sync, clock } = await setup(new ScriptedProvider([[P1], [P1]]));
    await sync();
    clock.advance(7200);
    await sync();
    const body = (await (await app.request(`/connections/${id}/posts`)).json()) as { posts: Array<Record<string, unknown>> };
    expect(body.posts[0]).toMatchObject({ fetched_at: "2026-06-02T12:00:00.000Z", last_fetched_at: "2026-06-02T14:00:00.000Z" });
  });
  it("dois syncs simultâneos da mesma conexão: um roda e o outro recebe 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: SocialProvider = { listPosts: async () => { await gate; return [P1]; } };
    const { sync, app, id } = await setup(slow);
    const first = sync();
    await new Promise((resolve) => setImmediate(resolve));
    const second = await sync();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "sync já em andamento para esta conexão" });
    release();
    expect((await first).status).toBe(200);
    expect((await sync()).status).toBe(200);
    const runs = (await (await app.request(`/connections/${id}/syncs`)).json()) as { syncs: unknown[] };
    expect(runs.syncs).toHaveLength(2);
  });
});
