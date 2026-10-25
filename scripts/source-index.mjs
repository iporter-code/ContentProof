import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const rows = [];
function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    else if (/\.(ts|tsx|sol|mjs|ps1|css|html)$/.test(path))
      rows.push({
        path: path.replaceAll("\\", "/"),
        lines: readFileSync(path, "utf8").split("\n").length,
      });
  }
}
for (const dir of ["apps", "packages", "scripts", "experiments", "test"])
  walk(dir);
writeFileSync(
  "docs/SOURCE_INDEX.md",
  `# 实际源代码索引\n\n由 npm run source:index 生成，只列真实源码，不列node_modules、运行数据库和构建产物。\n\n| 文件 | 行数 |\n|---|---:|\n${rows
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => `| ${r.path} | ${r.lines} |`)
    .join(
      "\n",
    )}\n\n总计 ${rows.length} 个源文件、${rows.reduce((n, r) => n + r.lines, 0)} 行。行数用于定位代码，不代表创新性或完成率。\n`,
);
console.log(`Indexed ${rows.length} source files.`);
