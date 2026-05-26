#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const src = process.argv[2] || "_site/data/incidents.jsonl";
const dir = process.argv[3] || "_site/data/incidents";

mkdirSync(dir, { recursive: true });
let count = 0;
for (const line of readFileSync(src, "utf8").split("\n")) {
  if (!line) continue;
  const inc = JSON.parse(line);
  writeFileSync(join(dir, `${inc.id}.json`), JSON.stringify(inc));
  count++;
}
unlinkSync(src);
console.log(`split ${count} incidents into ${dir}`);
