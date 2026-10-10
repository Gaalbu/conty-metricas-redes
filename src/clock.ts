export interface Clock {
  now(): Date;
  wait(seconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  wait: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};
