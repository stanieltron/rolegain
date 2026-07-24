import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolveCodexHome } from "../src/codex-runtime/client.js";
import { discoverCodexBinary } from "../src/codex-runtime/discover.js";

const projectRoot = process.cwd();
const codexHome = resolveCodexHome();
await mkdir(codexHome, { recursive: true, mode: 0o700 });

const binary = await discoverCodexBinary();
const login = spawn(binary, ["login"], {
  cwd: projectRoot,
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: "inherit",
  windowsHide: true,
});

const exitCode = await new Promise<number>((resolve, reject) => {
  login.once("error", reject);
  login.once("exit", (code) => resolve(code ?? 1));
});
process.exitCode = exitCode;
