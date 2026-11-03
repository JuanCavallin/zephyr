/**
 * Group tasks into waves: a task runs in the first wave after every task it
 * depends on. Tasks are `{ id, dependsOn: string[] }`.
 */
export function waves(tasks) {
  const done = new Set();
  const out = [];
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const ready = remaining.filter((t) => t.dependsOn.every((d) => done.has(d)));
    out.push(ready.map((t) => t.id));
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter((t) => !done.has(t.id));
  }
  return out;
}
