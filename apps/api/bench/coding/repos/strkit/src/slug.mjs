/** URL slug: lowercase, every run of non-alphanumerics becomes one dash. */
export function slugify(text, max = 40) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max);
}
