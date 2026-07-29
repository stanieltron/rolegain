import type { IncomingMessage } from "node:http";
import type { AuthenticatedActor } from "./auth.js";
import { HttpError } from "./auth.js";

interface WindowState {
  startedAt: number;
  count: number;
}

export class ApiRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  enforce(request: IncomingMessage, actor: AuthenticatedActor) {
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    const limit = mutation ? 60 : 240;
    const key = `${actor.userId}:${mutation ? "write" : "read"}`;
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return;
    }
    current.count += 1;
    if (current.count > limit)
      throw new HttpError(
        429,
        "Too many requests; try again shortly",
        "rate_limited",
      );
  }

  private prune(now: number) {
    if (this.windows.size < 10_000) return;
    for (const [key, state] of this.windows)
      if (now - state.startedAt >= 60_000) this.windows.delete(key);
  }
}
