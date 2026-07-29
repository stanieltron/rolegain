import { chromium, type Browser } from "playwright";

export class BrowserPool {
  private readonly active = new Map<Browser, string>();
  private readonly generations = new Map<string, number>();

  currentGeneration(candidateId: string) {
    return this.generations.get(candidateId) ?? 0;
  }

  async cancelAll() {
    for (const candidateId of new Set(this.active.values()))
      this.generations.set(candidateId, this.currentGeneration(candidateId) + 1);
    const browsers = [...this.active.keys()];
    this.active.clear();
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  }

  async cancel(candidateId: string) {
    this.generations.set(candidateId, this.currentGeneration(candidateId) + 1);
    const browsers = [...this.active]
      .filter(([, owner]) => owner === candidateId)
      .map(([browser]) => browser);
    for (const browser of browsers) this.active.delete(browser);
    await Promise.all(
      browsers.map((browser) => browser.close().catch(() => undefined)),
    );
  }

  async launch(candidateId: string, expectedGeneration: number) {
    if (expectedGeneration !== this.currentGeneration(candidateId))
      throw new Error("Background execution is stopped");
    const browser = await chromium.launch({ headless: true });
    if (expectedGeneration !== this.currentGeneration(candidateId)) {
      await browser.close().catch(() => undefined);
      throw new Error("Background execution is stopped");
    }
    this.active.set(browser, candidateId);
    return browser;
  }

  async close(browser: Browser) {
    this.active.delete(browser);
    await browser.close();
  }
}
