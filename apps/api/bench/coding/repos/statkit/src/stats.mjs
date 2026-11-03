/** Arithmetic mean. */
export function mean(values) {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Sample variance (n - 1). */
export function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let total = 0;
  for (const v of values) total += (v - m) ** 2;
  return total / (values.length - 1);
}

/** The q-quantile, 0 <= q <= 1, linearly interpolated between order statistics. */
export function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  return sorted[Math.floor(index)];
}

/** The median. */
export function median(values) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
