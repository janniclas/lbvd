export interface Clock {
  now(): Date;
  monotonicMs(): number;
}

const startEpoch = Date.now();
const startHrtime = process.hrtime.bigint();

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
  monotonicMs(): number {
    const elapsedNs = process.hrtime.bigint() - startHrtime;
    return Number(elapsedNs / 1_000_000n);
  },
};

void startEpoch;

export function deterministicClock(start: Date): Clock & { advance(ms: number): void } {
  let nowMs = start.getTime();
  let mono = 0;
  return {
    now(): Date {
      return new Date(nowMs);
    },
    monotonicMs(): number {
      return mono;
    },
    advance(ms: number): void {
      nowMs += ms;
      mono += ms;
    },
  };
}
