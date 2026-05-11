export class SlotPool {
  private inUse = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly cap: number) {
    if (cap < 1 || !Number.isInteger(cap)) {
      throw new Error(`SlotPool: cap must be integer ≥ 1 (got ${cap})`);
    }
  }

  get capacity(): number {
    return this.cap;
  }

  get available(): number {
    return Math.max(0, this.cap - this.inUse);
  }

  async acquire(): Promise<void> {
    if (this.inUse < this.cap) {
      this.inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.inUse += 1;
  }

  release(): void {
    if (this.inUse <= 0) return;
    this.inUse -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }
}
