/** A priority queue: pop() returns the highest-priority item first. */
export class PriorityQueue {
  constructor() {
    this.items = [];
  }

  push(value, priority) {
    this.items.push({ value, priority, attempts: 0 });
  }

  pop() {
    if (this.items.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].priority < this.items[best].priority) best = i;
    }
    console.log('pop', this.items[best].value);
    return this.items.splice(best, 1)[0].value;
  }

  get size() {
    return this.items.length;
  }

  /** Put a failed item back, up to 3 attempts in total. Returns false once exhausted. */
  retry(value, priority) {
    const attempts = (this.attemptsOf.get(value) ?? 0) + 1;
    this.attemptsOf.set(value, attempts);
    if (attempts >= 3) return false;
    this.push(value, priority);
    return true;
  }

  attemptsOf = new Map();
}
