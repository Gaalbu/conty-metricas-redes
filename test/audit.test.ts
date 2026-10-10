import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { PostSnapshot } from "../src/provider.ts";
import { FakeClock, ScriptedProvider } from "./support.ts";

const databases: DatabaseSync[] = [];
const CAPTURE = "2026-06-01T12:00:00.000Z";
const original: PostSnapshot = { external_id: "original", views: 10, captured_at: CAPTURE };

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function setup(batches: PostSnapshot[][]) {
  const db = openDatabase();
  databases.push(db);
  const provider = new ScriptedProvider(batches);
  const clock = new FakeClock("2026-06-02T12:00:00.000Z");
  const app = createApp({ db, provider, clock });
  const response = await app.request("/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "instagram", creator_id: "creator-audit" }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return {
    db,
    provider,
    clock,
    sync: () => app.request(`/connections/${id}/sync`, { method: "POST" }),
    posts: async () => (await app.request(`/connections/${id}/posts`)).json(),
  };
}

describe("integridade dos snapshots recebidos do provedor", () => {
  it("deduplica a mesma captura representada por instantes equivalentes em fusos distintos", async () => {
    const { db, sync, posts } = await setup([
      [original],
      [{ ...original, captured_at: "2026-06-01T09:00:00-03:00" }],
    ]);
    expect((await sync()).status).toBe(200);

    const repeated = await sync();

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM post_snapshots").get()).toEqual({ count: 1 });
    expect(await posts()).toMatchObject({ total_views: 10, posts: [{ ...original }] });
  });

  it("escolhe a captura cronologicamente mais recente mesmo quando seu fuso inverte a ordem textual", async () => {
    const { sync, posts } = await setup([
      [{ ...original, captured_at: "2026-06-01T10:00:00.000Z" }],
      [{ ...original, views: 50, captured_at: "2026-06-01T09:00:00-03:00" }],
    ]);
    expect((await sync()).status).toBe(200);
    expect((await sync()).status).toBe(200);

    expect(await posts()).toMatchObject({
      total_views: 50,
      posts: [{ external_id: "original", views: 50, captured_at: CAPTURE }],
    });
  });

  it.each([
    ["captura inválida", { ...original, captured_at: "não é um instante" }],
    ["identificador vazio", { ...original, external_id: " " }],
    ["views negativas", { ...original, views: -1 }],
    ["views fracionárias", { ...original, views: 1.5 }],
    ["views acima do limite inteiro seguro", { ...original, views: Number.MAX_SAFE_INTEGER + 1 }],
    ["snapshot nulo", null],
  ])("recusa %s no fim do lote sem gravar seus itens válidos nem repetir a chamada", async (_name, invalid) => {
    // O cast reproduz dados de integração que não respeitam o contrato TypeScript.
    const batch = [
      { external_id: "new", views: 20, captured_at: CAPTURE },
      invalid,
    ] as PostSnapshot[];
    const { db, sync, posts, provider, clock } = await setup([[original], batch]);
    expect((await sync()).status).toBe(200);
    const before = db.prepare("SELECT * FROM post_snapshots ORDER BY id").all();

    const rejected = await sync();

    expect.soft(rejected.status).toBe(502);
    expect(db.prepare("SELECT * FROM post_snapshots ORDER BY id").all()).toEqual(before);
    expect(await posts()).toMatchObject({ total_views: 10, posts: [{ ...original }] });
    expect(provider.calls).toBe(2);
    expect(clock.waits).toEqual([]);
  });

  it("recusa com 409 views conflitantes para uma captura já salva e desfaz os outros itens do lote", async () => {
    const { db, sync, posts } = await setup([
      [original],
      [
        { external_id: "new", views: 20, captured_at: CAPTURE },
        { ...original, views: 999, captured_at: "2026-06-01T09:00:00-03:00" },
      ],
    ]);
    expect((await sync()).status).toBe(200);
    const before = db.prepare("SELECT * FROM post_snapshots ORDER BY id").all();

    const conflict = await sync();

    expect.soft(conflict.status).toBe(409);
    expect(db.prepare("SELECT * FROM post_snapshots ORDER BY id").all()).toEqual(before);
    expect(await posts()).toMatchObject({ total_views: 10, posts: [{ ...original }] });
  });

  it("recusa com 409 duas capturas conflitantes dentro do mesmo lote e não salva nenhuma", async () => {
    const { db, sync, posts } = await setup([
      [original, { ...original, views: 999, captured_at: "2026-06-01T09:00:00-03:00" }],
    ]);

    const conflict = await sync();

    expect.soft(conflict.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM post_snapshots").get()).toEqual({ count: 0 });
    expect(await posts()).toMatchObject({ total_views: 0, posts: [] });
  });
});

describe("capturas gravadas antes da normalização", () => {
  it("passam para ISO UTC ao abrir o banco, e a equivalente já salva fica intacta com aviso", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metricas-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const legacy = openDatabase(path);
      legacy.exec(`
        INSERT INTO connections VALUES ('con_1', 'instagram', 'crt_ana', 'demo');
        INSERT INTO post_snapshots (connection_id, external_id, views, captured_at, fetched_at) VALUES
          ('con_1', 'p1', 10, '2026-06-01T09:00:00-03:00', '2026-06-01T13:00:00.000Z'),
          ('con_1', 'p2', 20, '2026-06-01T12:00:00.000Z', '2026-06-01T13:00:00.000Z'),
          ('con_1', 'p2', 20, '2026-06-01T09:00:00-03:00', '2026-06-01T13:00:00.000Z');
      `);
      legacy.close();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const db = openDatabase(path);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
      expect(db.prepare("SELECT external_id, captured_at FROM post_snapshots ORDER BY id").all()).toEqual([
        { external_id: "p1", captured_at: "2026-06-01T12:00:00.000Z" },
        { external_id: "p2", captured_at: "2026-06-01T12:00:00.000Z" },
        { external_id: "p2", captured_at: "2026-06-01T09:00:00-03:00" },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("erro inesperado do adaptador", () => {
  it("responde 502 com contexto, sem token, sem retry e sem gravar", async () => {
    const db = openDatabase();
    databases.push(db);
    const leaky = { listPosts: async () => { throw new TypeError("Cannot read properties of undefined (token demo_secret)"); } };
    const clock = new FakeClock("2026-06-02T12:00:00.000Z");
    const app = createApp({ db, provider: leaky, clock });
    const created = await app.request("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "youtube", creator_id: "crt_ana" }),
    });
    const { id } = (await created.json()) as { id: string };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(`/connections/${id}/sync`, { method: "POST" });
    error.mockRestore();

    expect(res.status).toBe(502);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("falha inesperada do provedor");
    expect(body).not.toContain("demo_secret");
    expect(clock.waits).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM post_snapshots").get()).toEqual({ count: 0 });
  });
});
