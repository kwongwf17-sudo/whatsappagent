import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeImageKnowledgeChunk } from "../lib/knowledge_sanitizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const targets = [
  path.join(rootDir, "data", "product_catalog.json"),
  path.join(rootDir, "data", "team_content.json"),
];

let totalChanged = 0;

for (const filePath of targets) {
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  const changed = sanitizeDocument(data);
  if (changed > 0) {
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  totalChanged += changed;
  console.log(`${path.relative(rootDir, filePath)}: sanitized ${changed} approved image chunk(s)`);
}

console.log(`Total sanitized chunks: ${totalChanged}`);

function sanitizeDocument(value) {
  let changed = 0;
  visit(value, (node) => {
    const chunks = node?.extracted_knowledge?.approvedImages;
    if (!Array.isArray(chunks)) return;
    for (let index = 0; index < chunks.length; index += 1) {
      const original = chunks[index];
      const sanitized = sanitizeImageKnowledgeChunk(original);
      if (JSON.stringify(original) !== JSON.stringify(sanitized)) {
        chunks[index] = sanitized;
        changed += 1;
      }
    }
  });
  return changed;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  for (const item of Object.values(value)) visit(item, callback);
}
