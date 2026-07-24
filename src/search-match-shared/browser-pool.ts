import { chromium, type Browser } from "playwright";

export class BrowserPool {
  private readonly active = new Set<Browser>();
  private generation = 0;

  get currentGeneration() {
    return this.generation;
  }

  async cancelAll() {
    this.generation += 1;
    const browsers = [...this.active];
    this.active.clear();
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  }

  async launch(expectedGeneration: number) {
    if (expectedGeneration !== this.generation)
      throw new Error("Background execution is stopped");
    const browser = await chromium.launch({ headless: true });
    if (expectedGeneration !== this.generation) {
      await browser.close().catch(() => undefined);
      throw new Error("Background execution is stopped");
    }
    this.active.add(browser);
    return browser;
  }

  async close(browser: Browser) {
    this.active.delete(browser);
    await browser.close();
  }
}
