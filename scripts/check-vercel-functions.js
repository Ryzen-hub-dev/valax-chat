import { readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiRoot = resolve(root, "api");

async function collectFunctions(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFunctions(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

const functions = await collectFunctions(apiRoot);
const names = functions.map((file) => relative(root, file).replaceAll("\\", "/"));
console.log(`Vercel Serverless Functions: ${functions.length}/12`);
names.forEach((name) => console.log(`- ${name}`));

if (functions.length > 12) {
  console.error("Hobby plan function limit exceeded.");
  process.exitCode = 1;
}
