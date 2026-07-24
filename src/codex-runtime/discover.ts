import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function discoverCodexBinary(): Promise<string> {
  const configured = process.env.CODEX_BINARY;
  if (configured && (await exists(configured))) return configured;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const npmBinary = path.join(
        appData,
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      );
      if (await exists(npmBinary)) return npmBinary;
    }

    const found = await execFileAsync("where.exe", ["codex.exe"], { windowsHide: true })
      .then(({ stdout }) => stdout.split(/\r?\n/).find(Boolean))
      .catch(() => undefined);
    if (found) return found.trim();
  }

  return "codex";
}

export async function getCodexVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["--version"], { windowsHide: true });
  return stdout.trim().replace(/^codex-cli\s+/, "");
}

async function exists(value: string): Promise<boolean> {
  return access(value).then(() => true).catch(() => false);
}

