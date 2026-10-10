import type { Clock } from "../src/clock.ts";
import { ProviderFailure } from "../src/provider.ts";
import type { PostSnapshot, SocialProvider } from "../src/provider.ts";

// Provedor roteirizado: cada chamada consome o próximo item da lista.
export class ScriptedProvider implements SocialProvider {
  calls = 0;
  private readonly script: Array<PostSnapshot[] | ProviderFailure>;

  constructor(script: Array<PostSnapshot[] | ProviderFailure>) {
    this.script = script;
  }

  async listPosts(): Promise<PostSnapshot[]> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step instanceof ProviderFailure) throw step;
    return step ?? [];
  }
}

// Relógio de teste: wait não dorme, só avança o instante e guarda os segundos.
export class FakeClock implements Clock {
  waits: number[] = [];
  private current: number;

  constructor(start: string) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  async wait(seconds: number): Promise<void> {
    this.waits.push(seconds);
    this.current += seconds * 1000;
  }
}
