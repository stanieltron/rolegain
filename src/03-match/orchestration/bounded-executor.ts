/**
 * Small FIFO executor used to stream work between pipeline stages without
 * starting an unbounded number of browser or model calls.
 */
export class BoundedExecutor {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("BoundedExecutor concurrency must be a positive integer");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release() {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
