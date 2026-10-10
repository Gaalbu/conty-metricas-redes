export type Platform = "instagram" | "tiktok" | "youtube" | "x";
export const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube", "x"];

export type Connection = { id: string; platform: Platform; creator_id: string; token: string };

// Uma janela de leitura: o número de views do post naquele instante.
export type PostSnapshot = { external_id: string; views: number; captured_at: string };

export type FailureKind = "timeout" | "unavailable" | "rate_limited";

export class ProviderFailure extends Error {
  readonly kind: FailureKind;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: FailureKind, retryAfterSeconds?: number) {
    super(`provedor falhou: ${kind}`);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Única borda com a rede social. O token é fictício: não há OAuth aqui.
export interface SocialProvider {
  listPosts(connection: Connection): Promise<PostSnapshot[]>;
}
