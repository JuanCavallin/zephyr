/** "Hello World" -> "hello-world". */
export function kebabCase(text) {
  return text
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join('-');
}
