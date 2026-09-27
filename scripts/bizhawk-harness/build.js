"use strict";

// Builds the headless BizHawk harness from source on first use: finds or installs a .NET 8+ SDK,
// sparse-clones the chosen BizHawk release, applies the hooks in profiles.js, and compiles it with
// Harness.cs and Stubs.cs. Nothing is committed; everything lives under the cache directory.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PROFILES, REPOSITORY, SPARSE_PATHS, applyPatch } = require("./profiles.js");

const HARNESS_DIR = __dirname;
const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..");
const CS_SOURCES = ["Harness.cs", "Stubs.cs"].map((name) => path.join(HARNESS_DIR, name));
const MIN_SDK_MAJOR = 8;

function cacheRoot() {
  return process.env.TASDECK_HARNESS_CACHE || path.join(REPO_ROOT, ".cache", "bizhawk-harness");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", ...options.env },
  });
  if (result.error) {
    throw new Error(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n").slice(-40).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})\n${output}`);
  }
  return result.stdout || "";
}

function sdkMajors(dotnet) {
  const result = spawnSync(dotnet, ["--list-sdks"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((major) => Number.isInteger(major));
}

function localDotnet() {
  return path.join(cacheRoot(), "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
}

async function installDotnet(log) {
  const dir = path.join(cacheRoot(), "dotnet");
  fs.mkdirSync(dir, { recursive: true });
  const windows = process.platform === "win32";
  const scriptName = windows ? "dotnet-install.ps1" : "dotnet-install.sh";
  const scriptPath = path.join(cacheRoot(), scriptName);
  log(`Installing the .NET 8 SDK into ${dir} (one time, about 200 MB)...`);
  const response = await fetch(`https://dot.net/v1/${scriptName}`);
  if (!response.ok) {
    throw new Error(`could not download ${scriptName}: HTTP ${response.status}`);
  }
  fs.writeFileSync(scriptPath, Buffer.from(await response.arrayBuffer()));
  if (windows) {
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Channel", "8.0", "-InstallDir", dir, "-NoPath"]);
  } else {
    run("bash", [scriptPath, "--channel", "8.0", "--install-dir", dir, "--no-path"]);
  }
}

// A .NET 8 or newer SDK: TASDECK_DOTNET, then `dotnet` on PATH, then a private copy in the cache.
async function ensureDotnet(log) {
  const candidates = [process.env.TASDECK_DOTNET, "dotnet", localDotnet()].filter(Boolean);
  for (const candidate of candidates) {
    if (sdkMajors(candidate).some((major) => major >= MIN_SDK_MAJOR)) {
      return candidate;
    }
  }
  await installDotnet(log);
  if (!sdkMajors(localDotnet()).some((major) => major >= MIN_SDK_MAJOR)) {
    throw new Error("the .NET SDK install finished but no .NET 8+ SDK was found");
  }
  return localDotnet();
}

function sourceDir(profileName) {
  return path.join(cacheRoot(), "src", profileName);
}

function buildDir(profileName) {
  return path.join(cacheRoot(), "build", profileName);
}

function ensureSource(profileName, log) {
  const profile = PROFILES[profileName];
  const dir = sourceDir(profileName);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`Fetching BizHawk ${profile.tag} NES core sources...`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", profile.tag, "--filter=blob:none", "--sparse", REPOSITORY, dir]);
    run("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", ...SPARSE_PATHS]);
  } else {
    // Start every patch pass from pristine sources.
    run("git", ["-C", dir, "checkout", "--quiet", "--", "."]);
  }
  for (const patch of profile.patches) {
    const file = path.join(dir, patch.file);
    fs.writeFileSync(file, applyPatch(fs.readFileSync(file, "utf8"), patch));
  }
  return dir;
}

function csproj(profile, bizhawkSrc) {
  const bh = path.join(bizhawkSrc, "src");
  const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const compile = (pattern, excludes = []) =>
    `    <Compile Include="${xml(path.join(bh, pattern))}"${excludes.length ? ` Exclude="${xml(excludes.map((e) => path.join(bh, e)).join(";"))}"` : ""} />`;
  const soundExcludes = profile.excludes.filter((e) => e.includes("/Sound/"));
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <RollForward>Major</RollForward>
    <AssemblyName>tasdeck-harness</AssemblyName>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <LangVersion>${profile.langVersion}</LangVersion>
    <Nullable>disable</Nullable>
    <NoWarn>$(NoWarn);CS0618;CS8632;CS0169;CS0414;CS0649;CS0162;CS0168;CS0219;CS1998;CA1416;SYSLIB0011;CS8981;CS0108;CS0114</NoWarn>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <Optimize>true</Optimize>
    <InvariantGlobalization>true</InvariantGlobalization>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
    <DefineConstants>$(DefineConstants)${profile.defineConstants.map((c) => `;${c}`).join("")}</DefineConstants>
  </PropertyGroup>
  <ItemGroup>
${profile.usings.map(([name, alias]) => `    <Using Include="${name}"${alias ? ` Alias="${alias}"` : ""} />`).join("\n")}
  </ItemGroup>
  <ItemGroup>
${compile("BizHawk.Common/**/*.cs")}
${compile("BizHawk.BizInvoke/**/*.cs")}
${compile("BizHawk.Emulation.Common/**/*.cs", ["BizHawk.Emulation.Common/Sound/BlipBuffer.cs"])}
${compile("BizHawk.Emulation.Cores/Consoles/Nintendo/NES/**/*.cs")}
${compile("BizHawk.Emulation.Cores/Consoles/Nintendo/SubNESHawk/**/*.cs")}
${compile("BizHawk.Emulation.Cores/CPUs/MOS 6502X/**/*.cs")}
${compile("BizHawk.Emulation.Cores/Sound/*.cs", soundExcludes)}
${compile("BizHawk.Emulation.Cores/CoreNames.cs")}
${CS_SOURCES.map((file) => `    <Compile Include="${xml(file)}" />`).join("\n")}
  </ItemGroup>
  <ItemGroup>
${profile.packages.map(([name, version, excludeAssets]) => `    <PackageReference Include="${name}" Version="${version}"${excludeAssets ? ` ExcludeAssets="${excludeAssets}"` : ""} />`).join("\n")}
  </ItemGroup>
</Project>
`;
}

function buildStamp(profileName) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(PROFILES[profileName]));
  for (const file of CS_SOURCES) {
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

// Returns { dotnet, dll, gamedb } for a built harness, building it first if needed.
async function ensureHarness(profileName, log = () => {}) {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`unknown BizHawk version ${profileName}; choose one of ${Object.keys(PROFILES).join(", ")}`);
  }
  const dotnet = await ensureDotnet(log);
  const dir = buildDir(profileName);
  const dll = path.join(dir, "out", "tasdeck-harness.dll");
  const stampFile = path.join(dir, "stamp");
  const stamp = buildStamp(profileName);
  const gamedb = path.join(sourceDir(profileName), "Assets", "gamedb");
  if (fs.existsSync(dll) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) {
    return { dotnet, dll, gamedb, profile: profileName };
  }

  const src = ensureSource(profileName, log);
  log(`Building the BizHawk ${profile.tag} harness...`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const project = path.join(dir, "harness.csproj");
  fs.writeFileSync(project, csproj(profile, src));
  // Keep NuGet packages with the rest of the cache, so deleting it removes everything.
  run(dotnet, ["build", project, "-c", "Release", "-o", path.join(dir, "out"), "--nologo", "-v", "quiet"], {
    env: { NUGET_PACKAGES: path.join(cacheRoot(), "nuget") },
  });
  fs.writeFileSync(stampFile, stamp);
  return { dotnet, dll, gamedb, profile: profileName };
}

module.exports = {
  cacheRoot,
  csproj,
  ensureHarness,
};
