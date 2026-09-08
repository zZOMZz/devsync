import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, digest, command, platformKey, verifyArchive } from "./core.mjs";
const silentStage = async (_label, task) => task({ consume() {} });
import { userCacheDirectory, withCacheLock } from "./cache.mjs";
const manifest = await readJson(
  fileURLToPath(new URL("./releases.json", import.meta.url)),
);
const binaryName = process.platform === "win32" ? "mutagen.exe" : "mutagen";
const tar = process.platform === "win32" ? "tar.exe" : "tar";
const payloads = [binaryName, "mutagen-agents.tar.gz"];

async function payloadHashes(dir) {
  const hashes = {};
  for (const name of payloads) {
    if (!(await fs.lstat(path.join(dir, name))).isFile()) throw Error("程序包文件无效。");
    hashes[name] = digest(await fs.readFile(path.join(dir, name)));
  }
  return hashes;
}
async function validatePayload(dir, version, run) {
  const hashes = await payloadHashes(dir);
  if ((await run(path.join(dir, binaryName), ["version"])).trim() !== version)
    throw Error("Mutagen 版本不匹配。");
  const entries = (await run(tar, ["-tzf", path.join(dir, "mutagen-agents.tar.gz")])).trim();
  if (!entries) throw Error("Mutagen agent 程序包为空。");
  return hashes;
}
async function ready(dir, release) {
  try {
    const receipt = await readJson(path.join(dir, "verified.json"));
    return receipt.version === release.version &&
      receipt.archiveSha256 === release.asset.sha256 &&
      JSON.stringify(receipt.files) === JSON.stringify(await payloadHashes(dir));
  } catch { return false; }
}

export async function ensureTool(root, {
  cacheRoot = userCacheDirectory(), releaseManifest = manifest, key = platformKey(),
  run = command, download = downloadArchive, stage = silentStage, log = () => {},
  env = process.env,
} = {}) {
  const asset = releaseManifest.assets[key];
  if (!asset) throw Error(`暂不支持 ${key}。支持 macOS ARM64、Windows/Linux x64 和 ARM64。`);
  const release = { version: releaseManifest.version, asset };
  const dir = path.join(cacheRoot, release.version, key);
  const binary = path.join(dir, binaryName);
  if (await ready(dir, release)) return binary;
  return withCacheLock(dir + ".lock", async () => {
    if (await ready(dir, release)) return binary;
    log(`正在准备共享 Mutagen ${release.version}（${key}）…`);
    const temp = await fs.mkdtemp(dir + ".install-");
    try {
      const legacy = path.join(root, ".sync", "tools", `mutagen-${release.version}-${key}`);
      let files;
      try {
        // Previous installers already verified the official archive checksum.
        // Copy first and validate the copy; keep old paths valid for running daemons.
        for (const name of payloads) {
          if (!(await fs.lstat(path.join(legacy, name))).isFile()) throw Error("旧缓存文件无效");
          await fs.copyFile(path.join(legacy, name), path.join(temp, name));
        }
        files = await validatePayload(temp, release.version, run);
        log("✓ 已校验并复用项目中的旧 Mutagen 程序，无需下载。");
      } catch {
        for (const name of payloads) await fs.rm(path.join(temp, name), { force: true });
      }
      if (!files) {
        const archive = path.join(temp, "archive.tar.gz");
        if ((env.DEVSYNC_MUTAGEN_ARCHIVE || env.SYNC_MUTAGEN_ARCHIVE))
          await stage("复制本地程序包", () => fs.copyFile((env.DEVSYNC_MUTAGEN_ARCHIVE || env.SYNC_MUTAGEN_ARCHIVE), archive));
        else {
          const base = (env.DEVSYNC_MUTAGEN_MIRROR || env.SYNC_MUTAGEN_MIRROR) || releaseManifest.baseUrl;
          await download(`${base.replace(/\/$/, "")}/${asset.file}`, archive, {
            proxy: env.DEVSYNC_DOWNLOAD_PROXY || env.SYNC_DOWNLOAD_PROXY || env.HTTPS_PROXY || env.https_proxy || "",
            stage, log,
          });
        }
        await stage("校验程序包 SHA-256", () => verifyArchive(archive, asset.sha256));
        const entries = (await run(tar, ["-tzf", archive])).trim().split(/\r?\n/);
        if (entries.some(p => p.startsWith("/") || p.includes("\\") || p.split("/").includes("..")))
          throw Error("程序包包含不安全路径。");
        await stage("解压程序包", () => run(tar, ["-xzf", archive, "-C", temp]));
        await fs.unlink(archive);
        if (process.platform !== "win32") await fs.chmod(path.join(temp, binaryName), 0o700);
        files = await validatePayload(temp, release.version, run);
      }
      await writeJson(path.join(temp, "verified.json"), {
        version: release.version, archiveSha256: asset.sha256, files,
      });
      // Never expose a partially extracted installation to other projects.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(temp, dir);
      log("✓ 共享同步工具已就绪");
      return binary;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, { log });
}

// Keep downloading while data flows, regardless of the total elapsed time.
export async function downloadArchive(
  url,
  archive,
  {
    proxy = "",
    run = command,
    stage = silentStage,
    log = () => {},
  } = {},
) {
  const attempts = [
    ...(proxy ? [{ label: "通过代理下载 Mutagen", args: ["--proxy", proxy, "--noproxy", ""] }] : []),
    { label: "直连下载 Mutagen", args: ["--noproxy", "*"] },
  ];
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    try {
      await stage(attempt.label, (progress) =>
        run(
          process.platform === "win32" ? "curl.exe" : "curl",
          [
            "-fL",
            "--connect-timeout",
            "20",
            "--max-time",
            "0",
            "--speed-limit",
            "1024",
            "--speed-time",
            "120",
            ...attempt.args,
            "-o",
            archive,
            url,
          ],
          { timeout: 0, onStderr: (chunk) => progress.consume(chunk) },
        ),
      );
      return;
    } catch (error) {
      if (index < attempts.length - 1) log("代理下载失败，正在尝试直连…");
      else
        throw new Error(
          "下载失败。请检查网络，或设置 DEVSYNC_MUTAGEN_MIRROR / DEVSYNC_MUTAGEN_ARCHIVE 后重试。\n" +
            error.message,
        );
    }
  }
}
