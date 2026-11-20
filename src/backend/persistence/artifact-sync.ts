import type { ArtifactArchive } from "./artifact-archive.js";

/** Serialize local artifact access and refresh after a worker publishes a snapshot. */
export class ArtifactSync {
  private readonly revisions = new Map<string, string>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly archive: ArtifactArchive) {}

  async run<T>(userId: string, revision: () => Promise<string>, work: () => Promise<T>) {
    const previous = this.pending.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const current = await revision();
      if (this.revisions.get(userId) !== current) {
        await this.archive.restore(userId);
        this.revisions.set(userId, current);
      }
      return work();
    });
    this.pending.set(userId, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(userId) === task) this.pending.delete(userId);
    }
  }
}
