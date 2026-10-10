import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { ProviderFailure } from "../src/provider.ts";
import type { PostSnapshot } from "../src/provider.ts";
import { FakeClock, HANG, ScriptedProvider } from "./support.ts";

const NOW = "2026-06-01T12:00:00.000Z";

async function setup(script: Array<PostSnapshot[] | ProviderFailure>, options?: { maxAttempts: number; maxWaitSeconds: number }) {
  const provider = new ScriptedProvider(script);
  const clock = new FakeClock(NOW);
  const app = createApp({ db: openDatabase(), provider, clock, options });
  const res = await app.request("/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "instagram", creator_id: "crt_ana" }),
  });
  const { id } = (await res.json()) as { id: string };
  const sync = () => app.request(`/connections/${id}/sync`, { method: "POST" });
  return { app, id, provider, clock, sync };
}

describe("sincronização de métricas", () => {
  it("janela repetida não conta duas vezes: p2 vira duplicata, p3 entra, soma 35", async () => {
    const { app, id, sync } = await setup([
      [
        { external_id: "p1", views: 10, captured_at: "2026-06-01T10:00:00.000Z" },
        { external_id: "p2", views: 20, captured_at: "2026-06-01T10:00:00.000Z" },
      ],
      [
        { external_id: "p2", views: 20, captured_at: "2026-06-01T10:00:00.000Z" },
        { external_id: "p3", views: 5, captured_at: "2026-06-01T11:00:00.000Z" },
      ],
    ]);

    expect((await (await sync()).json()) as object).toMatchObject({ inserted: 2, duplicates: 0 });
    const second = await sync();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ inserted: 1, duplicates: 1 });

    const res = await app.request(`/connections/${id}/posts`);
    const body = (await res.json()) as { total_views: number; posts: Array<{ external_id: string; fetched_at: string }> };
    expect(body.posts.map((p) => p.external_id)).toEqual(["p1", "p2", "p3"]);
    expect(body.total_views).toBe(35);
    expect(body.posts.every((p) => p.fetched_at === NOW)).toBe(true);
  });

  it("devolve a janela mais recente de cada post, não a soma das janelas", async () => {
    const { app, id, sync } = await setup([
      [{ external_id: "p1", views: 10, captured_at: "2026-06-01T10:00:00.000Z" }],
      [{ external_id: "p1", views: 40, captured_at: "2026-06-01T11:00:00.000Z" }],
    ]);
    await sync();
    await sync();
    const body = (await (await app.request(`/connections/${id}/posts`)).json()) as { total_views: number };
    expect(body.total_views).toBe(40);
  });

  it("429 com Retry-After 7 e teto 30 espera 7 segundos e termina 200", async () => {
    const { sync, clock } = await setup([new ProviderFailure("rate_limited", 7), []], {
      maxAttempts: 4,
      maxWaitSeconds: 30,
    });
    const res = await sync();
    expect(res.status).toBe(200);
    expect(clock.waits).toEqual([7]);
  });

  it("429 com Retry-After 90 respeita o teto de 30 segundos", async () => {
    const { sync, clock } = await setup([new ProviderFailure("rate_limited", 90), []], {
      maxAttempts: 4,
      maxWaitSeconds: 30,
    });
    expect((await sync()).status).toBe(200);
    expect(clock.waits).toEqual([30]);
  });

  it("timeout em todas as tentativas com teto 3 devolve 503 depois de 3 chamadas e esperas 1 e 2", async () => {
    const { sync, clock, provider } = await setup([new ProviderFailure("timeout")], {
      maxAttempts: 3,
      maxWaitSeconds: 30,
    });
    const res = await sync();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "provedor indisponível", attempts: 3 });
    expect(provider.calls).toBe(3);
    expect(clock.waits).toEqual([1, 2]);
  });

  it("recusa plataforma desconhecida e conexão inexistente", async () => {
    const { app } = await setup([[]]);
    const res = await app.request("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "orkut", creator_id: "crt_ana" }),
    });
    expect(res.status).toBe(400);
    expect((await app.request("/connections/con_x/sync", { method: "POST" })).status).toBe(404);
  });
});

describe("prazo por tentativa", () => {
  it("provedor que não responde estoura o prazo, tem o pedido abortado e a próxima tentativa grava", async () => {
    const provider = new ScriptedProvider([
      HANG,
      [{ external_id: "p1", views: 7, captured_at: "2026-06-01T10:00:00.000Z" }],
    ]);
    const clock = new FakeClock(NOW);
    const app = createApp({ db: openDatabase(), provider, clock, options: { attemptTimeoutSeconds: 10 } });
    const created = await app.request("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "tiktok", creator_id: "crt_ana" }),
    });
    const { id } = (await created.json()) as { id: string };

    const pending = app.request(`/connections/${id}/sync`, { method: "POST" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider.calls).toBe(1);
    clock.advance(10);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attempts: 2, inserted: 1 });
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(provider.signals[1]?.aborted).toBe(false);
    expect(clock.waits).toEqual([1]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("provedor travado em todas as tentativas termina em 503 em vez de prender a request", async () => {
    const provider = new ScriptedProvider([HANG]);
    const clock = new FakeClock(NOW);
    const app = createApp({ db: openDatabase(), provider, clock, options: { maxAttempts: 2, attemptTimeoutSeconds: 5 } });
    const created = await app.request("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "x", creator_id: "crt_ana" }),
    });
    const { id } = (await created.json()) as { id: string };

    const pending = app.request(`/connections/${id}/sync`, { method: "POST" });
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(5);
    }
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ attempts: 2, last_failure: "timeout" });
    expect(provider.signals.every((signal) => signal.aborted)).toBe(true);
  });
});
