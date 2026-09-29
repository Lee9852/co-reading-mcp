import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const DEFAULT_WEBDAV_URL = "https://dav.jianguoyun.com/dav/";
const DEFAULT_REMOTE_DIR = "co-reading-mcp";
const DEFAULT_BACKUP_FILE = "backup.json.gz";
const EXCLUDED_TOP_LEVEL = new Set(["uploads", "trash", ".write-lock"]);

let backupTimer = null;
let syncQueue = Promise.resolve();
let status = {
  enabled: false,
  provider: "jianguoyun-webdav",
  lastBackupAt: null,
  lastRestoreAt: null,
  lastError: null,
};

function config() {
  const username = process.env.JIANGUOYUN_WEBDAV_USER || "";
  const password = process.env.JIANGUOYUN_WEBDAV_PASSWORD || "";
  const baseUrl = process.env.JIANGUOYUN_WEBDAV_URL || DEFAULT_WEBDAV_URL;
  const remoteDir = process.env.JIANGUOYUN_WEBDAV_DIR || DEFAULT_REMOTE_DIR;
  const backupFile = process.env.JIANGUOYUN_WEBDAV_BACKUP_FILE || DEFAULT_BACKUP_FILE;
  return {
    username,
    password,
    baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    remoteDir: remoteDir.replace(/^\/+|\/+$/g, "") || DEFAULT_REMOTE_DIR,
    backupFile: backupFile.replace(/^\/+/, "") || DEFAULT_BACKUP_FILE,
    enabled: Boolean(username && password),
  };
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function remoteUrl(baseUrl, ...segments) {
  const encoded = segments
    .filter(Boolean)
    .flatMap((segment) => String(segment).split("/"))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return new URL(encoded, baseUrl).toString();
}

async function davRequest(method, url, { body, headers = {} } = {}) {
  const cfg = config();
  const response = await fetch(url, {
    method,
    headers: {
      authorization: authHeader(cfg.username, cfg.password),
      ...headers,
    },
    body,
  });
  return response;
}

async function ensureRemoteDir() {
  const cfg = config();
  if (!cfg.enabled) return false;
  const url = remoteUrl(cfg.baseUrl, cfg.remoteDir);
  const response = await davRequest("MKCOL", url);
  if ([200, 201, 204, 301, 302, 405].includes(response.status)) return true;
  const body = await response.text().catch(() => "");
  throw new Error(`WebDAV MKCOL failed (${response.status}) ${body.slice(0, 200)}`);
}

async function walkFiles(root, current = root, output = []) {
  let entries = [];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return output;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const rel = path.relative(root, fullPath);
    const top = rel.split(path.sep)[0];

    if (EXCLUDED_TOP_LEVEL.has(top)) continue;
    if (entry.name.endsWith(".tmp")) continue;
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, output);
      continue;
    }
    if (!entry.isFile()) continue;

    const file = await readFile(fullPath);
    output.push({
      path: rel.split(path.sep).join("/"),
      data: file.toString("base64"),
    });
  }
  return output;
}

async function hasMeaningfulLocalData(root) {
  const files = await walkFiles(root);
  return files.some((file) => {
    if (!file.path || file.path.startsWith(".")) return false;
    return file.data.length > 0;
  });
}

function safeDestination(root, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  const destination = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  return destination;
}

async function writeBundle(root, bundle) {
  if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.files)) {
    throw new Error("Unsupported or invalid cloud backup format");
  }
  await mkdir(root, { recursive: true });
  for (const file of bundle.files) {
    const destination = safeDestination(root, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(String(file.data || ""), "base64"));
  }
}

export function cloudSyncStatus() {
  const cfg = config();
  return {
    ...status,
    enabled: cfg.enabled,
    remoteDir: cfg.enabled ? cfg.remoteDir : null,
  };
}

export async function restoreCloudBackup(dataDir) {
  const cfg = config();
  status.enabled = cfg.enabled;
  if (!cfg.enabled) return { restored: false, reason: "not-configured" };

  if (await hasMeaningfulLocalData(dataDir)) {
    return { restored: false, reason: "local-data-present" };
  }

  try {
    const response = await davRequest("GET", remoteUrl(cfg.baseUrl, cfg.remoteDir, cfg.backupFile));
    if (response.status === 404) {
      status.lastError = null;
      return { restored: false, reason: "no-backup" };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`WebDAV restore failed (${response.status}) ${body.slice(0, 200)}`);
    }

    const compressed = Buffer.from(await response.arrayBuffer());
    const json = await gunzipAsync(compressed);
    const bundle = JSON.parse(json.toString("utf8"));
    await writeBundle(dataDir, bundle);

    status.lastRestoreAt = new Date().toISOString();
    status.lastError = null;
    process.stderr.write(`Cloud restore complete: ${bundle.files.length} files from JianGuoYun.\n`);
    return { restored: true, files: bundle.files.length, createdAt: bundle.createdAt || null };
  } catch (error) {
    status.lastError = error.message || String(error);
    throw error;
  }
}

export async function backupCloudData(dataDir) {
  const cfg = config();
  status.enabled = cfg.enabled;
  if (!cfg.enabled) return { backedUp: false, reason: "not-configured" };

  try {
    await ensureRemoteDir();
    const files = await walkFiles(dataDir);
    const bundle = {
      version: 1,
      createdAt: new Date().toISOString(),
      files,
    };
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(bundle), "utf8"), { level: 6 });
    const response = await davRequest("PUT", remoteUrl(cfg.baseUrl, cfg.remoteDir, cfg.backupFile), {
      body: compressed,
      headers: {
        "content-type": "application/gzip",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`WebDAV backup failed (${response.status}) ${body.slice(0, 200)}`);
    }

    status.lastBackupAt = new Date().toISOString();
    status.lastError = null;
    process.stderr.write(`Cloud backup complete: ${files.length} files to JianGuoYun.\n`);
    return { backedUp: true, files: files.length, bytes: compressed.length };
  } catch (error) {
    status.lastError = error.message || String(error);
    throw error;
  }
}

export function scheduleCloudBackup(dataDir, delayMs = 1200) {
  if (!config().enabled) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    const run = () => backupCloudData(dataDir);
    syncQueue = syncQueue.then(run, run).catch((error) => {
      process.stderr.write(`Cloud backup error: ${error.message || error}\n`);
    });
  }, delayMs);
}
