/** Shorten text to at most `max` characters, ending in an ellipsis when cut. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
