#!/usr/bin/env node
/**
 * check-module-boundaries — 阻止 form-assist 与 material-audit 互相 import。
 *
 * 规则:
 *   - extension/src/modules/form-assist/** 不能 import 自 material-audit/**
 *   - extension/src/modules/material-audit/** 不能 import 自 form-assist/**
 *   - 两个 module 内部对 ../shared/* 的 import 是允许的(共享 substrate)
 *
 * 用法: node scripts/check-module-boundaries.mjs
 *      npm run check:boundaries
 *
 * 退出码:0 = 干净;1 = 违规(打印违规位置)。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const MODULES_DIR = path.join(ROOT, "src", "modules");

// 互相禁止 import 的模块名集合
const FORBIDDEN_PAIRS = [
  ["form-assist", "material-audit"],
  ["material-audit", "form-assist"],
];

async function* walk(dir) {
  const entries = await readdir(dir);
  for (const name of entries) {
    const p = path.join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function moduleNameOf(filePath) {
  // 期望: src/modules/<module>/...
  const rel = path.relative(MODULES_DIR, filePath);
  const first = rel.split(path.sep)[0];
  return first || null;
}

function otherModuleInImport(importTarget, ownerModule) {
  // importTarget e.g. "../../material-audit/foo" 或 "../material-audit"
  if (importTarget.includes("/material-audit/") || importTarget.includes("/material-audit\"") ||
      importTarget.startsWith("../material-audit/") || importTarget === "../material-audit") {
    return "material-audit";
  }
  if (importTarget.includes("/form-assist/") || importTarget.includes("/form-assist\"") ||
      importTarget.startsWith("../form-assist/") || importTarget === "../form-assist") {
    return "form-assist";
  }
  return null;
}

const violations = [];

for (const [a, b] of FORBIDDEN_PAIRS) {
  const modDir = path.join(MODULES_DIR, a);
  let files;
  try {
    files = [];
    for await (const f of walk(modDir)) files.push(f);
  } catch {
    continue;
  }
  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // 跳过注释行
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
      // 匹配 import ... from "..."
      const m = line.match(/from\s+["']([^"']+)["']/);
      if (!m) return;
      const target = m[1];
      const other = otherModuleInImport(target, a);
      if (other === b) {
        violations.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          from: a,
          to: b,
          target,
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error("❌ 模块边界违规:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.from} → ${v.to}  (import "${v.target}")`);
  }
  console.error(`\n共 ${violations.length} 处违规。修复:form-assist 与 material-audit 互不依赖,通过 shared/* 通信。`);
  process.exit(1);
}

console.log("✅ 模块边界干净: form-assist 与 material-audit 无互相 import。");