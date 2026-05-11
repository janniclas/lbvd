import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotPool } from "../../src/dispatcher/slot.js";

test("respects concurrency cap under burst", async () => {
  const pool = new SlotPool(3);
  let inFlight = 0;
  let max = 0;
  const work = async (): Promise<void> => {
    await pool.acquire();
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    pool.release();
  };
  await Promise.all(Array.from({ length: 10 }, () => work()));
  assert.ok(max <= 3, `max=${max}`);
});
