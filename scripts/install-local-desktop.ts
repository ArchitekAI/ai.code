#!/usr/bin/env node

import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_APP_NAME = process.env.T3CODE_DESKTOP_PRODUCT_NAME?.trim() || "AI Code";
const DEFAULT_APP_ID = process.env.T3CODE_DESKTOP_APP_ID?.trim() || "com.t3tools.aicode";
const DEFAULT_OUTPUT_DIR = "release-local-install";

interface InstallOptions {
  readonly pull: boolean;
  readonly open: boolean;
  readonly arch: "arm64" | "x64";
  readonly appName: string;
  readonly appId: string;
  readonly installDir: string;
  readonly outputDir: string;
}

function parseArgs(argv: ReadonlyArray<string>): InstallOptions {
  let pull = true;
  let open = true;
  let arch: "arm64" | "x64" = process.arch === "arm64" ? "arm64" : "x64";
  let appName = DEFAULT_APP_NAME;
  let appId = DEFAULT_APP_ID;
  let installDir = process.env.T3CODE_DESKTOP_INSTALL_DIR?.trim() || "";

  for (const arg of argv) {
    if (arg === "--no-pull") {
      pull = false;
      continue;
    }
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg.startsWith("--arch=")) {
      const value = arg.slice("--arch=".length);
      if (value === "arm64" || value === "x64") {
        arch = value;
      }
      continue;
    }
    if (arg.startsWith("--app-name=")) {
      appName = arg.slice("--app-name=".length).trim() || appName;
      continue;
    }
    if (arg.startsWith("--app-id=")) {
      appId = arg.slice("--app-id=".length).trim() || appId;
      continue;
    }
    if (arg.startsWith("--install-dir=")) {
      installDir = arg.slice("--install-dir=".length).trim();
      continue;
    }
  }

  return {
    pull,
    open,
    arch,
    appName,
    appId,
    installDir: installDir || resolveDefaultInstallDir(),
    outputDir: resolve(process.cwd(), DEFAULT_OUTPUT_DIR),
  };
}

function resolveDefaultInstallDir(): string {
  for (const candidate of ["/Applications", join(homedir(), "Applications")]) {
    try {
      if (!existsSync(candidate)) {
        mkdirSync(candidate, { recursive: true });
      }
      accessSync(candidate, constants.W_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Could not find a writable Applications directory.");
}

function run(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function findBuiltApp(rootDir: string): string {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.endsWith(".app")) {
        return entryPath;
      }
      stack.push(entryPath);
    }
  }

  throw new Error(`Could not find a built .app inside ${rootDir}`);
}

function quitInstalledApp(appName: string): void {
  spawnSync("osascript", ["-e", `tell application "${appName}" to quit`], {
    stdio: "ignore",
  });
}

function installBuiltApp(sourceAppPath: string, destinationAppPath: string): void {
  rmSync(destinationAppPath, { recursive: true, force: true });
  cpSync(sourceAppPath, destinationAppPath, { recursive: true });
}

function main(): void {
  if (process.platform !== "darwin") {
    throw new Error("dist:install currently supports macOS only.");
  }

  const options = parseArgs(process.argv.slice(2));
  const destinationAppPath = join(options.installDir, `${options.appName}.app`);

  console.log(`[dist:install] Installing ${options.appName} to ${destinationAppPath}`);

  if (options.pull) {
    run("git", ["pull", "--ff-only"]);
  }

  run("bun", ["install"]);

  rmSync(options.outputDir, { recursive: true, force: true });
  // Build a local .app directly so updates can replace the Dock app without DMG mounting.
  run(
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dir",
      "--arch",
      options.arch,
      "--output-dir",
      options.outputDir,
    ],
    {
      T3CODE_DESKTOP_PRODUCT_NAME: options.appName,
      T3CODE_DESKTOP_APP_ID: options.appId,
    },
  );

  const builtAppPath = findBuiltApp(options.outputDir);
  quitInstalledApp(options.appName);
  installBuiltApp(builtAppPath, destinationAppPath);

  if (options.open) {
    run("open", [destinationAppPath]);
  }

  console.log(`[dist:install] Installed ${options.appName} successfully.`);
}

main();
