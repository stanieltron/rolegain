import { afterEach, describe, expect, it, vi } from "vitest";
import { readSupplementalEvidence } from "../src/01-evidence-ingestion/01-evidence-acquisition/additional-evidence/read-source.js";

const input = { kind: "webpage" as const, name: "evidence.txt", url: "https://93.184.216.34/start" };
afterEach(() => vi.unstubAllGlobals());

describe("supplemental source redirect limit", () => {
  it("reads the final document after exactly four redirects", async () => {
    const fetch = vi.fn();
    for (let i = 1; i <= 4; i++)
      fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `/hop-${i}` } }));
    fetch.mockResolvedValueOnce(new Response("Built a reliable platform and led production operations.", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await readSupplementalEvidence(input);
    expect(result.content).toContain("reliable platform");
    expect(result.url).toBe("https://93.184.216.34/hop-4");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("bounds redirect loops and recommends a direct link", async () => {
    const fetch = vi.fn(async () => new Response("redirect", { status: 302, headers: { location: "/start" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(readSupplementalEvidence(input)).rejects.toThrow("limit of 4 redirects");
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const result of await Promise.all(fetch.mock.results.map((call) => call.value)))
      expect(result.bodyUsed).toBe(true);
  });
  it("still rejects private destinations reached through a redirect", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(readSupplementalEvidence(input)).rejects.toThrow("Private network URLs");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
