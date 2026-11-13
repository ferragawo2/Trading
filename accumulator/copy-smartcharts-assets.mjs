import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("@deriv-com/smartcharts-champion"));
const target = path.resolve("chart-dist");
await fs.mkdir(target, { recursive: true });
for (const entry of await fs.readdir(dist, { withFileTypes: true })) {
  if (entry.isFile() && (entry.name.endsWith(".smartcharts.js") || entry.name.endsWith(".smartcharts.css") || entry.name === "smartcharts.css")) {
    await fs.copyFile(path.join(dist, entry.name), path.join(target, entry.name));
  }
}
const assets = path.join(dist, "chart", "assets");
try {
  await fs.cp(assets, path.join(target, "assets"), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log("Copied SmartCharts async chunks, stylesheet and chart assets.");
