import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const walk = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
};

const shouldSkipSpecifier = (s) => {
  if (!s.startsWith("./") && !s.startsWith("../")) return true;
  if (s.includes("?") || s.includes("#")) return true;
  if (s.endsWith(".js") || s.endsWith(".mjs") || s.endsWith(".cjs")) return true;
  if (s.endsWith(".json") || s.endsWith(".node")) return true;
  return false;
};

const resolveReplacement = async (filePath, specifier) => {
  if (shouldSkipSpecifier(specifier)) return null;

  const basePath = path.resolve(path.dirname(filePath), specifier);

  if (await exists(`${basePath}.js`)) {
    return `${specifier}.js`;
  }
  if (await exists(path.join(basePath, "index.js"))) {
    return `${specifier}/index.js`;
  }

  return null;
};

const rewriteFile = async (filePath) => {
  const original = await fs.readFile(filePath, "utf8");
  let changed = false;

  const replaceAsync = async (input, regex, replacer) => {
    const matches = Array.from(input.matchAll(regex));
    if (matches.length === 0) return input;

    let out = "";
    let lastIndex = 0;
    for (const m of matches) {
      const start = m.index;
      const end = start + m[0].length;
      out += input.slice(lastIndex, start);
      out += await replacer(m);
      lastIndex = end;
    }
    out += input.slice(lastIndex);
    return out;
  };

  let next = original;

  next = await replaceAsync(
    next,
    /(\bfrom\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
    async (m) => {
      const prefix = m[1];
      const spec = m[2];
      const suffix = m[3];
      const repl = await resolveReplacement(filePath, spec);
      if (!repl) return m[0];
      changed = true;
      return `${prefix}${repl}${suffix}`;
    },
  );

  next = await replaceAsync(
    next,
    /(\bimport\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
    async (m) => {
      const prefix = m[1];
      const spec = m[2];
      const suffix = m[3];
      const repl = await resolveReplacement(filePath, spec);
      if (!repl) return m[0];
      changed = true;
      return `${prefix}${repl}${suffix}`;
    },
  );

  if (!changed) return false;

  await fs.writeFile(filePath, next, "utf8");
  return true;
};

const main = async () => {
  if (!(await exists(distDir))) {
    console.log("postbuild: dist/ not found, skipping");
    return;
  }

  const files = (await walk(distDir)).filter((f) => f.endsWith(".js"));
  let updated = 0;

  for (const f of files) {
    if (await rewriteFile(f)) updated++;
  }

  console.log(`postbuild: fixed import specifiers in ${updated} file(s)`);
};

await main();

