import type { Clock, Timer } from "../src/clock.ts";
import { ProviderFailure } from "../src/provider.ts";
import type { PostSnapshot, SocialProvider } from "../src/provider.ts";

// Provedor roteirizado: cada chamada consome o próximo item da lista.
// "hang" simula um provedor que nunca responde; o signal recebido fica guardado.
export const HANG = "hang" as const;

export class ScriptedProvider implements SocialProvider {
  calls = 0;
  signals: AbortSignal[] = [];
  private readonly script: Array<PostSnapshot[] | ProviderFailure | typeof HANG>;

  constructor(script: Array<PostSnapshot[] | ProviderFailure | typeof HANG>) {
    this.script = script;
  }

  async listPosts(_connection: unknown, signal?: AbortSignal): Promise<PostSnapshot[]> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (signal) this.signals.push(signal);
    if (step === HANG) return new Promise<PostSnapshot[]>(() => {});
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
    this.advance(seconds);
  }

  // Prazos só expiram quando o teste avança o relógio.
  private timers: Array<{ due: number; fire: () => void; active: boolean }> = [];

  timer(seconds: number): Timer {
    let fire = () => {};
    const expired = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const entry = { due: this.current + seconds * 1000, fire, active: true };
    this.timers.push(entry);
    return { expired, cancel: () => void (entry.active = false) };
  }

  pendingTimers(): number {
    return this.timers.filter((t) => t.active).length;
  }

  advance(seconds: number): void {
    this.current += seconds * 1000;
    for (const entry of this.timers) {
      if (entry.active && entry.due <= this.current) {
        entry.active = false;
        entry.fire();
      }
    }
  }
}
