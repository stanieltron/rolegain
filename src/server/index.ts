import path from "node:path";
import { createRolegainApp } from "./app.js";

const app = await createRolegainApp({
  dataRoot: process.env.ROLEGAIN_DATA_ROOT
    ? path.resolve(process.env.ROLEGAIN_DATA_ROOT)
    : undefined,
});
const port = await app.start();
console.log(`RolegAIn listening at http://127.0.0.1:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
