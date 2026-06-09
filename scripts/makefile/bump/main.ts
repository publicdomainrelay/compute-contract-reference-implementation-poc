const libsDir = Deno.args[0] ?? "src/typescript/lib";

const paths: string[] = [];
for (const entry of Deno.readDirSync(libsDir)) {
  if (!entry.isDirectory) continue;
  const pkgPath = `${libsDir}/${entry.name}/package.json`;
  try {
    Deno.statSync(pkgPath);
    paths.push(pkgPath);
  } catch {
    // no package.json in this dir
  }
}
paths.sort();

for (const pkgPath of paths) {
  const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
  if (pkg.private) continue;

  const parts = pkg.version.split(".");
  parts[2] = String(Number(parts[2]) + 1);
  pkg.version = parts.join(".");

  Deno.writeTextFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${pkg.name} -> ${pkg.version}`);
}
