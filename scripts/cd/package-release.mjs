import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// No environment files or local MCP configuration enter a release.
export function packageRelease({
  source,
  output,
  sha,
  nodeBinary = process.execPath,
  runtime = {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  },
}) {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("A full commit SHA is required");
  if (
    runtime.platform !== "linux" ||
    runtime.arch !== "x64" ||
    !runtime.node.startsWith("24.")
  ) {
    throw new Error("Production releases require Linux x64 and Node 24");
  }
  for (const file of [".next/standalone/server.js", ".next/static", "public"]) {
    if (!existsSync(join(source, file)))
      throw new Error(`Missing build output: ${file}`);
  }
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "personchat-front-package-"));
  try {
    // mkdtemp creates 0700. The archive root inherits this mode, and the
    // personchat-front service user must be able to traverse the release.
    chmodSync(stage, 0o755);
    cpSync(join(source, ".next/standalone"), stage, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) =>
        !path
          .split(/[\\/]/)
          .some(
            (part) =>
              part === ".git" || part === ".claude" || part.startsWith(".env"),
          ),
    });
    cpSync(join(source, ".next/static"), join(stage, ".next/static"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    cpSync(join(source, "public"), join(stage, "public"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    mkdirSync(join(stage, "runtime"), { recursive: true });
    cpSync(nodeBinary, join(stage, "runtime/node"));
    chmodSync(join(stage, "runtime/node"), 0o755);
    const manifest = {
      sha,
      platform: runtime.platform,
      arch: runtime.arch,
      node: runtime.node,
    };
    writeFileSync(join(stage, "release.json"), JSON.stringify(manifest) + "\n");
    writeFileSync(
      join(stage, "public/personchat-release.json"),
      JSON.stringify({ sha }) + "\n",
    );
    const defaults = join(source, "app/mcp/mcp_config.default.json");
    if (existsSync(defaults)) {
      mkdirSync(join(stage, "app/mcp"), { recursive: true });
      cpSync(defaults, join(stage, "app/mcp/mcp_config.json"));
    }
    const archive = join(output, "release.tgz");
    execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
    const digest = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    writeFileSync(
      join(output, "release.tgz.sha256"),
      `${digest}  release.tgz\n`,
    );
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  packageRelease({
    source: process.cwd(),
    output: resolve(process.argv[2] ?? "release"),
    sha: process.env.GITHUB_SHA ?? "",
  });
}
