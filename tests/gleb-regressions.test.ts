import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { profileSchema, validate } from "../src/server/validation.js";
import { ArtifactSync } from "../src/backend/persistence/artifact-sync.js";
import { LocalArtifactArchive } from "../src/backend/persistence/artifact-archive.js";
import { captureSearchV2Leads } from "../src/02-search/v2/harness/capture.js";
import { searchV2Configuration } from "../src/02-search/v2/config.js";
import type { SearchV2Lead } from "../src/02-search/v2/contracts.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (["beebreeze.cc", "saifuro.com"].includes(host))
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  }),
}));

describe("Gleb's November 20 regressions", () => {
  it("accepts bare GitHub/website links and identifies an invalid field", () => {
    expect(validate(profileSchema, {
      github: " github.com/gleb-urvanov ", website: "beebreeze.cc",
    })).toEqual({ github: "https://github.com/gleb-urvanov", website: "https://beebreeze.cc" });
    expect(validate(profileSchema, { github: "https://github.com/gleb-urvanov" }))
      .toEqual({ github: "https://github.com/gleb-urvanov" });
    expect(() => validate(profileSchema, { website: "not a url" })).toThrow(/website:/);
    expect(() => validate(profileSchema, { github: "javascript:alert(1)" })).toThrow(/github:/);
    expect(validate(profileSchema, { website: " " })).toEqual({ website: "" });
  });

  it("continues the capture batch after both failing domains and unsafe/invalid links", async () => {
    const close = vi.fn(async () => undefined);
    const newPage = vi.fn(async () => ({
      goto: async () => ({ status: () => 200 }),
      waitForFunction: async () => undefined,
      evaluate: async () => ({ finalUrl: "https://jobs.example.com/rust", pageTitle: "Rust Engineer",
        body: "Rust Engineer position. ".repeat(20), links: [], forms: [] }),
      close,
    }));
    const urls = ["https://beebreeze.cc", "https://saifuro.com", "invalid url", "http://127.0.0.1", "https://jobs.example.com/rust"];
    const leads = urls.map((url, index): SearchV2Lead => ({
      id: String(index), url, title: "Rust Engineer", company: "Example", location: "Remote",
      workplaceType: "remote", employmentType: "full-time", sourceKind: "vacancy",
      query: "Rust", sourceClass: "search_engine", snippet: "", compensation: "", wave: 1,
    }));
    const captures = await captureSearchV2Leads({
      browser: { newPage } as unknown as Browser, leads,
      configuration: { ...searchV2Configuration({}), settleMs: 0 },
    });
    expect(captures).toHaveLength(5);
    expect(captures[0].navigationError).toContain("ENOTFOUND beebreeze.cc");
    expect(captures[1].navigationError).toContain("ENOTFOUND saifuro.com");
    expect(captures.slice(0, 4).every((item) => !item.signals.hasUsableEvidence)).toBe(true);
    expect(captures[4].signals.hasUsableEvidence).toBe(true);
    expect(newPage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refreshes an existing web session after worker completion without repeated downloads", async () => {
    const archive = new LocalArtifactArchive();
    let remote = "before analysis";
    let local = "";
    const restore = vi.spyOn(archive, "restore").mockImplementation(async () => { local = remote; });
    const sync = new ArtifactSync(archive);
    const read = () => Promise.resolve(local);
    expect(await sync.run("gleb", async () => "initial", read)).toBe("before analysis");
    remote = "new evidence model";
    expect(await sync.run("gleb", async () => "completed-analysis", read)).toBe(remote);
    await Promise.all([1, 2, 3].map(() => sync.run("gleb", async () => "completed-analysis", read)));
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("retries a failed restore and does not overwrite an in-flight local mutation", async () => {
    const archive = new LocalArtifactArchive();
    const restore = vi.spyOn(archive, "restore").mockRejectedValueOnce(new Error("storage unavailable"));
    const sync = new ArtifactSync(archive);
    const order: string[] = [];
    await expect(sync.run("gleb", async () => "a", async () => undefined)).rejects.toThrow("storage unavailable");
    restore.mockImplementation(async () => { order.push("restore"); });
    await Promise.all([
      sync.run("gleb", async () => "a", async () => { order.push("write"); await Promise.resolve(); order.push("snapshot"); }),
      sync.run("gleb", async () => "b", async () => { order.push("read"); }),
    ]);
    expect(order).toEqual(["restore", "write", "snapshot", "restore", "read"]);
  });
});
