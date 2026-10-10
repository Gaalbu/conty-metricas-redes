export type Timer = { expired: Promise<void>; cancel(): void };

export interface Clock {
  now(): Date;
  wait(seconds: number): Promise<void>;
  // Prazo cancelável: expira depois de `seconds`, a menos que cancel() venha antes.
  timer(seconds: number): Timer;
}

export const systemClock: Clock = {
  now: () => new Date(),
  wait: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  timer(seconds) {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, seconds * 1000);
    });
    return { expired, cancel: () => clearTimeout(handle) };
  },
};
