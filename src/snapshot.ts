import type { PostSnapshot } from "./provider.ts";

// O provedor é JSON de integração: o tipo TypeScript não garante nada em runtime.
// O lote inteiro é validado antes de qualquer gravação, e o instante vira ISO UTC
// canônico, para "09:00-03:00" e "12:00Z" serem a mesma captura na chave única.

export type InvalidSnapshot = { index: number; reason: string };

export function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function validateBatch(raw: unknown): { posts: PostSnapshot[] } | { invalid: InvalidSnapshot } {
  if (!Array.isArray(raw)) return { invalid: { index: -1, reason: "o provedor não devolveu uma lista" } };
  const posts: PostSnapshot[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") return { invalid: { index, reason: "snapshot não é um objeto" } };
    const { external_id, views, captured_at } = item as Record<string, unknown>;
    if (typeof external_id !== "string" || !external_id.trim()) {
      return { invalid: { index, reason: "external_id vazio" } };
    }
    if (typeof views !== "number" || !Number.isSafeInteger(views) || views < 0) {
      return { invalid: { index, reason: "views deve ser inteiro seguro maior ou igual a 0" } };
    }
    const instant = canonicalInstant(captured_at);
    if (!instant) return { invalid: { index, reason: "captured_at não é um instante" } };
    posts.push({ external_id: external_id.trim(), views, captured_at: instant });
  }
  return { posts };
}
