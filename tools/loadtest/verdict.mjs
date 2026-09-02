/**
 * Did the run pass?
 *
 * Six criteria, evaluated only over the hold window — the ramp is a transient
 * and judging a system by its transient is how you end up tuning for the wrong
 * thing. Each one is checked separately and reported separately, so a failure
 * says *which* property broke rather than handing back a table and an opinion.
 *
 * `evaluate` returns a verdict; the runner turns it into an exit code. A load
 * test that cannot fail is a demo.
 */

export const SLO = {
  /** Sender -> shard -> sender. How fast the inbound pipeline decides. */
  ackP99Ms: 250,
  /** Sender -> shard -> coordinator -> every shard -> receiver. */
  deliveryP99Ms: 1_000,
  /** Share of handshakes that never opened. */
  failedHandshakeRatio: 0.005,
  /** Presence the room reports vs sockets the generator holds. */
  presenceDriftRatio: 0.01,
};

/**
 * @param {object} input
 * @param {number} input.opened          sockets that reached `open`
 * @param {number} input.requested       sockets the run intended to open
 * @param {number} input.failed          sockets that errored before opening
 * @param {number} input.acked           messages the server acknowledged
 * @param {number} input.deliveredOwn    acked messages that came back to their sender
 * @param {number} input.presenceMax     highest presence any shard reported
 * @param {number} input.openAtHold      sockets open when the hold window ended
 * @param {number} input.maxShardSockets highest socket count on a single shard
 * @param {number} input.maxSocketsPerShard configured ceiling, 0 when unknown
 * @param {{p99?: number, count: number}} input.ackLatency
 * @param {{p99?: number, count: number}} input.deliveryLatency
 */
export function evaluate(input) {
  const checks = [];

  const check = (name, ok, detail, skipped = false) =>
    checks.push({ name, ok: skipped ? null : ok, detail, skipped });

  check(
    "ack p99",
    (input.ackLatency.p99 ?? Infinity) <= SLO.ackP99Ms,
    input.ackLatency.count
      ? `${input.ackLatency.p99}ms (limit ${SLO.ackP99Ms}ms)`
      : "no messages were acked",
    input.ackLatency.count === 0,
  );

  check(
    "delivery p99",
    (input.deliveryLatency.p99 ?? Infinity) <= SLO.deliveryP99Ms,
    input.deliveryLatency.count
      ? `${input.deliveryLatency.p99}ms (limit ${SLO.deliveryP99Ms}ms)`
      : "no frames were delivered",
    input.deliveryLatency.count === 0,
  );

  const attempted = input.requested || 1;
  const failedRatio = input.failed / attempted;
  check(
    "handshakes",
    failedRatio <= SLO.failedHandshakeRatio,
    `${input.failed}/${input.requested} failed (${(failedRatio * 100).toFixed(2)}%, limit ${(SLO.failedHandshakeRatio * 100).toFixed(2)}%)`,
  );

  // The one criterion with no tolerance. A message the server acknowledged and
  // then delivered to nobody is the failure this whole architecture exists to
  // not have; sampling withholds messages from *viewers*, never from the sender.
  const lost = Math.max(0, input.acked - input.deliveredOwn);
  check(
    "no acked message lost",
    lost === 0,
    lost === 0 ? `${input.acked} acked, ${input.acked} came back` : `${lost} acked but never delivered`,
    input.acked === 0,
  );

  const drift =
    input.openAtHold > 0 ? Math.abs(input.presenceMax - input.openAtHold) / input.openAtHold : 0;
  check(
    "presence converges",
    drift <= SLO.presenceDriftRatio,
    `reported ${input.presenceMax} vs ${input.openAtHold} open (${(drift * 100).toFixed(2)}% drift, limit ${(SLO.presenceDriftRatio * 100).toFixed(2)}%)`,
    input.presenceMax === 0,
  );

  const ceiling = input.maxSocketsPerShard;
  // Skipped, not passed, when we never saw a per-shard number: "0 of 5000" is
  // not a room behaving well, it is a measurement that did not happen.
  const unobserved = ceiling === 0 || input.maxShardSockets === 0;
  check(
    "shard ceiling respected",
    input.maxShardSockets <= ceiling,
    unobserved
      ? "no per-shard socket count was observed"
      : `busiest shard held ${input.maxShardSockets} of ${ceiling}`,
    unobserved,
  );

  const failed = checks.filter((c) => c.ok === false);
  return {
    passed: failed.length === 0,
    checks,
    failedCount: failed.length,
    skippedCount: checks.filter((c) => c.skipped).length,
  };
}

/**
 * What stopped the run growing — the *generator's* limits, not the server's.
 *
 * Without this a report says "we reached 28.000 sockets" and cannot say whether
 * that is the chat's ceiling or the laptop's, which makes the number useless.
 * These are the three walls one machine actually hits, in the order it hits them.
 */
export function diagnoseSaturation({ requested, opened, failed, portRange, errorCodes }) {
  const reasons = [];

  const ports = Math.max(0, portRange.end - portRange.start + 1);
  if (opened >= ports * 0.9) {
    reasons.push(
      `ephemeral ports: ${opened} sockets against a range of ${ports} (${portRange.start}-${portRange.end}). ` +
        `One machine cannot exceed this per destination IP — widen net.ipv4.ip_local_port_range or add a machine.`,
    );
  }

  const codes = Object.entries(errorCodes ?? {}).sort((a, b) => b[1] - a[1]);
  const top = codes[0];
  if (top) {
    const [code, count] = top;
    if (code === "EMFILE" || code === "ENFILE") {
      reasons.push(`file descriptors: ${count}x ${code}. Raise \`ulimit -n\` before the run.`);
    } else if (code === "EADDRNOTAVAIL") {
      reasons.push(`no local address left: ${count}x EADDRNOTAVAIL — the port range is exhausted.`);
    } else if (code === "ECONNRESET" || code === "ECONNREFUSED") {
      reasons.push(
        `the far end refused or reset ${count} connections (${code}) — this one is the server or the network, not the generator.`,
      );
    } else if (code === "ETIMEDOUT") {
      reasons.push(`${count} handshakes timed out (${code}) — TLS setup is the bottleneck, add CPU or machines.`);
    } else {
      reasons.push(`${count}x ${code} during connect.`);
    }
  }

  if (failed === 0 && opened >= requested) {
    reasons.push("nothing saturated: every socket the run asked for was opened.");
  }

  return reasons;
}
