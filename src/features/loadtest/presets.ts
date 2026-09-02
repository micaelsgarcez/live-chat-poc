/**
 * The fixed windows a load test may run in.
 *
 * Fixed on purpose: a ladder of named steps, each one only run after the one
 * below it passed. Ad-hoc numbers produce runs that cannot be compared with
 * each other, and jumping straight to the top spends real money discovering a
 * bug that the smallest step would have found for free.
 *
 * Every preset has the same shape — 60s ramp, 30s at full load — so the only
 * variables between two runs are the size of the room and how much of it talks.
 * `shards` is the placement count the room should be configured with beforehand
 * (`connections / MAX_SOCKETS_PER_SHARD`, rounded up), and `machines` is how
 * many load generators it takes, at roughly 10k sockets each.
 */
export interface LoadTestPreset {
  name: string;
  connections: number;
  talkers: number;
  shards: number;
  machines: number;
  rampSeconds: number;
  holdSeconds: number;
}

const SHAPE = { rampSeconds: 60, holdSeconds: 30 };

export const LOADTEST_PRESETS: readonly LoadTestPreset[] = [
  { name: "smoke", connections: 1_000, talkers: 200, shards: 1, machines: 1, ...SHAPE },
  { name: "small", connections: 10_000, talkers: 2_000, shards: 2, machines: 1, ...SHAPE },
  { name: "medium", connections: 50_000, talkers: 10_000, shards: 10, machines: 5, ...SHAPE },
  { name: "large", connections: 100_000, talkers: 20_000, shards: 20, machines: 10, ...SHAPE },
  { name: "xlarge", connections: 200_000, talkers: 35_000, shards: 40, machines: 20, ...SHAPE },
  { name: "max", connections: 300_000, talkers: 50_000, shards: 60, machines: 30, ...SHAPE },
];

export function findPreset(name: string): LoadTestPreset | null {
  return LOADTEST_PRESETS.find((preset) => preset.name === name) ?? null;
}
