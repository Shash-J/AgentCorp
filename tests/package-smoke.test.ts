import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Package Release Smoke Test: Clean Outside-Checkout Installation", () => {
  let tempWorkDir: string;
  let cleanClientDir: string;
  let tarballPath: string;
  let packageFiles: string[];

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  beforeAll(() => {
    // 1. Create temporary directory to hold packed tarball
    tempWorkDir = mkdtempSync(join(tmpdir(), "agentcorp-smoke-pack-"));
    cleanClientDir = mkdtempSync(join(tmpdir(), "agentcorp-smoke-client-"));

    // 2. Build and pack the project into tempWorkDir
    const packOutput = execSync(`${npmCmd} pack --json --ignore-scripts --pack-destination "${tempWorkDir}"`, {
      cwd: resolve("."),
      encoding: "utf8",
    });
    const packed = JSON.parse(packOutput) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    expect(packed.length).toBe(1);
    tarballPath = join(tempWorkDir, packed[0]!.filename);
    packageFiles = packed[0]!.files.map((file) => file.path.replaceAll("\\", "/"));
  }, 60000);

  afterAll(() => {
    try {
      if (cleanClientDir && existsSync(cleanClientDir)) {
        rmSync(cleanClientDir, { recursive: true, force: true });
      }
      if (tempWorkDir && existsSync(tempWorkDir)) {
        rmSync(tempWorkDir, { recursive: true, force: true });
      }
    } catch {
      // Ignored cleanup errors
    }
  });

  it("ships the public runtime without internal or generated project state", () => {
    expect(packageFiles).toContain("dist/cli.js");
    expect(packageFiles).toContain("dist/index.d.ts");
    expect(packageFiles).toContain("docs/getting-started.md");
    expect(packageFiles).toContain("README.md");

    const forbiddenPaths = [
      ".agentcorp/",
      "coord/",
      "docs/design-spec.md",
      "docs/images/",
      "scratch/",
      "src/",
      "tests/",
    ];
    for (const forbidden of forbiddenPaths) {
      expect(packageFiles.some((path) => path === forbidden || path.startsWith(forbidden))).toBe(false);
    }
  });

  it("installs packed tarball into a fresh outside-checkout directory and executes CLI", () => {
    // 1. Initialize fresh npm project outside the repo
    execSync(`${npmCmd} init -y`, {
      cwd: cleanClientDir,
      stdio: "pipe",
    });

    // 2. Install the packed tarball
    execSync(`${npmCmd} install "${tarballPath}"`, {
      cwd: cleanClientDir,
      stdio: "pipe",
    });

    // 3. Test agentcorp --version
    const versionOutput = execSync(`${npxCmd} agentcorp --version`, {
      cwd: cleanClientDir,
      encoding: "utf8",
    }).trim();
    expect(versionOutput).toBe("0.1.0-alpha.1");

    // 4. Test agentcorp --help
    const helpOutput = execSync(`${npxCmd} agentcorp --help`, {
      cwd: cleanClientDir,
      encoding: "utf8",
    });
    expect(helpOutput).toContain("Usage: agentcorp [options] [command]");
    expect(helpOutput).toContain("init");
    expect(helpOutput).toContain("start");
    expect(helpOutput).toContain("review");

    // 5. Test agentcorp init
    const initOutput = execSync(`${npxCmd} agentcorp init`, {
      cwd: cleanClientDir,
      encoding: "utf8",
    });
    expect(initOutput).toContain('"created":');
    expect(initOutput).toContain('"roles":');
    expect(existsSync(join(cleanClientDir, "org.toml"))).toBe(true);
    expect(existsSync(join(cleanClientDir, ".agentcorp", "credentials.json"))).toBe(true);

    // 6. Test agentcorp validate
    const validateOutput = execSync(`${npxCmd} agentcorp validate`, {
      cwd: cleanClientDir,
      encoding: "utf8",
    });
    expect(validateOutput).toContain('"valid": true');
    expect(validateOutput).toContain('"company": "My Agent Company"');
  }, 120000);
});
