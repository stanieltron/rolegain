import { BoundedExecutor } from "./bounded-executor.js";

export interface StreamingPipelineInput<T, R, P> {
  concurrency: number;
  key: (item: T) => string;
  produce: (emit: (item: T) => void) => Promise<P>;
  consume: (item: T) => Promise<R>;
  onCompleted?: (item: T, result: R) => void | Promise<void>;
}

export interface TwoStageStreamingPipelineInput<T, U, R, P> {
  firstConcurrency: number;
  secondConcurrency: number;
  key: (item: T) => string;
  produce: (emit: (item: T) => void) => Promise<P>;
  first: (item: T) => Promise<U | undefined>;
  second: (item: U) => Promise<R>;
  onCompleted?: (item: U, result: R) => void | Promise<void>;
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

/**
 * Connect a producer to two independently bounded stages. A completed first
 * stage is submitted to the second immediately, without waiting for the
 * producer or the other first-stage items to finish.
 */
export async function runBoundedTwoStageStreamingPipeline<T, U, R, P>(
  input: TwoStageStreamingPipelineInput<T, U, R, P>,
): Promise<{ producerResult: P; results: R[] }> {
  const firstExecutor = new BoundedExecutor(input.firstConcurrency);
  const secondExecutor = new BoundedExecutor(input.secondConcurrency);
  const submitted = new Set<string>();
  const firstTasks: Array<Promise<void>> = [];
  const secondTasks: Array<Promise<R>> = [];

  const emit = (item: T) => {
    const key = input.key(item);
    if (submitted.has(key)) return;
    submitted.add(key);
    const firstTask = firstExecutor.run(async () => {
      const intermediate = await input.first(item);
      if (intermediate === undefined) return;
      const secondTask = secondExecutor.run(async () => {
        const result = await input.second(intermediate);
        await input.onCompleted?.(intermediate, result);
        return result;
      });
      void secondTask.catch(() => undefined);
      secondTasks.push(secondTask);
    });
    void firstTask.catch(() => undefined);
    firstTasks.push(firstTask);
  };

  let producerResult!: P;
  let producerError: unknown;
  let producerFailed = false;
  try {
    producerResult = await input.produce(emit);
  } catch (error) {
    producerFailed = true;
    producerError = error;
  }
  const firstSettled = await Promise.allSettled(firstTasks);
  const secondSettled = await Promise.allSettled(secondTasks);
  if (producerFailed) throw producerError;
  const rejected = [...firstSettled, ...secondSettled].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  const results = secondSettled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  return { producerResult, results };
}
