/** 1234 -> "$12.34". */
export function formatCents(cents) {
  return '$' + (cents / 100).toFixed(1);
}

/** 1234567 -> "1.2M", 15300 -> "15.3k". */
export function formatCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
