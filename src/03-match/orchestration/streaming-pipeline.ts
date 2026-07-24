import { BoundedExecutor } from "./bounded-executor.js";

export interface StreamingPipelineInput<T, R, P> {
  concurrency: number;
  key: (item: T) => string;
  produce: (emit: (item: T) => void) => Promise<P>;
  consume: (item: T) => Promise<R>;
  onCompleted?: (item: T, result: R) => void | Promise<void>;
}

/**
 * Connect one asynchronous producer to a bounded worker pool. `emit` schedules
 * an item immediately; it does not wait for the producer to finish or for other
 * items to reach the same stage.
 */
export async function runBoundedStreamingPipeline<T, R, P>(
  input: StreamingPipelineInput<T, R, P>,
): Promise<{ producerResult: P; results: R[] }> {
  const executor = new BoundedExecutor(input.concurrency);
  const submitted = new Set<string>();
  const tasks: Array<Promise<R>> = [];

  const emit = (item: T) => {
    const key = input.key(item);
    if (submitted.has(key)) return;
    submitted.add(key);
    const task = executor.run(async () => {
      const result = await input.consume(item);
      await input.onCompleted?.(item, result);
      return result;
    });
    tasks.push(task);
  };

  const producerResult = await input.produce(emit);
  const results = await Promise.all(tasks);
  return { producerResult, results };
}
