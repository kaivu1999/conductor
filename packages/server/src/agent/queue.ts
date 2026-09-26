/** Minimal push-able async iterable. Single consumer. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(item: T): boolean {
    if (this.ended) return false;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  /** No more items; the consumer finishes after draining what's buffered. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
