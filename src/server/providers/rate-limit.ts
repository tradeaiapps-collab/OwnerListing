export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) };

/** Token bucket: `capacity` calls at once, refilled at `perSecond`. acquire() waits (never rejects) until a token is free. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private readonly capacity: number, private readonly perSecond: number, private readonly clock: Clock = realClock) {
    if (!(capacity >= 1) || !(perSecond > 0)) throw new Error("RateLimiter needs capacity >= 1 and perSecond > 0.");
    this.tokens = capacity;
    this.last = clock.now();
  }
  private refill() {
    const t = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
  }
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
    }
  }
}
