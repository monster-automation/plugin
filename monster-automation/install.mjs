#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";

const endpoint = "https://app.monster-automation.com/api/mcp";
const pluginName = "monster-automation";
const markerName = ".ma-installation.json";
const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function statIfPresent(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function ensureDirectory(directory) {
  const existing = await statIfPresent(directory);
  if (!existing) await mkdir(directory, { mode: 0o700 });
  else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error("Небезопасный путь: вместо обычной папки обнаружена ссылка или файл.");
  }
}

async function readExact(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Ожидался обычный файл без символических ссылок.");
  return readFile(filename);
}

async function readRegular(filename) {
  return (await readExact(filename)).toString("utf8");
}

async function listRegularFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("В плагине обнаружена ссылка или специальный файл. Нужна ручная проверка.");
  }
  return files.sort();
}

export async function loadBundle(source = sourceRoot) {
  const manifestText = await readRegular(path.join(source, ".cursor-plugin/plugin.json"));
  const manifest = JSON.parse(manifestText);
  const configText = await readRegular(path.join(source, "mcp.json"));
  const config = JSON.parse(configText);
  if (manifest.name !== pluginName || manifest.mcpServers !== "./mcp.json"
    || !Array.isArray(manifest.skills) || manifest.skills.length < 1 || manifest.skills.length > 64
    || new Set(manifest.skills).size !== manifest.skills.length
    || Object.keys(config.mcpServers ?? {}).join() !== pluginName
    || config.mcpServers[pluginName].url !== endpoint
    || ![
      "Bearer ${MA_MCP_TOKEN}",
      "Bearer ${env:MA_MCP_TOKEN}",
    ].includes(config.mcpServers[pluginName].headers?.Authorization)) {
    throw new Error("Пакет не соответствует ожидаемому плагину. Получите исходный архив у администратора.");
  }
  const files = new Map([[".cursor-plugin/plugin.json", manifestText], ["mcp.json", configText]]);
  for (const skill of manifest.skills) {
    if (!/^\.\/skills\/ma-[a-z0-9-]+$/.test(skill)) throw new Error("Недопустимый путь skill в пакете.");
    const relative = `${skill.slice(2)}/SKILL.md`;
    files.set(relative, await readRegular(path.join(source, relative)));
  }
  if (typeof manifest.logo === "string") {
    if (!/^assets\/[A-Za-z0-9._-]+\.(png|svg)$/.test(manifest.logo)) {
      throw new Error("Недопустимый путь иконки в пакете.");
    }
    files.set(manifest.logo, await readExact(path.join(source, manifest.logo)));
  }
  return { files, config, version: manifest.version };
}

export async function install({ token, update = false, userHome = homedir(), source = sourceRoot }) {
  if (!/^ma_[A-Za-z0-9_-]{32}$/.test(token)) {
    throw new Error("Нужен персональный ключ ma_ и 32 символа после префикса. Выпустите его в разделе MCP-доступ.");
  }
  const { files, config, version } = await loadBundle(source);
  // Do not follow redirected config directories or modify other Cursor MCP entries.
  let current = userHome;
  for (const segment of [".cursor", "plugins", "local"]) {
    current = path.join(current, segment);
    await ensureDirectory(current);
  }
  const target = path.join(current, pluginName);
  const existing = await statIfPresent(target);
  if (existing) {
    if (!update) throw new Error("Плагин уже установлен. Для обновления или замены ключа запустите с --update.");
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Целевая папка не является обычной папкой.");
    // Only replace an installation owned by this installer, and preserve local edits.
    const marker = JSON.parse(await readRegular(path.join(target, markerName)));
    if (marker.name !== pluginName || marker.format !== 1 || !marker.files || typeof marker.files !== "object" || Array.isArray(marker.files)) {
      throw new Error("Существующий плагин установлен другим способом. Автоматическая замена запрещена.");
    }
    if (json(await listRegularFiles(target)) !== json([...Object.keys(marker.files), "mcp.json", markerName].sort())) {
      throw new Error("В установленной папке есть неизвестные или отсутствующие файлы. Нужна ручная проверка.");
    }
    const oldConfig = JSON.parse(await readRegular(path.join(target, "mcp.json")));
    const oldHeaders = oldConfig.mcpServers?.[pluginName]?.headers;
    if (!oldHeaders || typeof oldHeaders.Authorization !== "string") {
      throw new Error("MCP-конфигурация изменена вручную. Нужна ручная проверка.");
    }
    oldHeaders.Authorization = "Bearer ${MA_MCP_TOKEN}";
    if (json(oldConfig) !== json(config)) {
      throw new Error("MCP-конфигурация изменена вручную. Нужна ручная проверка.");
    }
    for (const [relative, hash] of Object.entries(marker.files)) {
      if (!files.has(relative)) throw new Error("Состав установленного плагина изменился. Нужна ручная проверка.");
      if (digest(await readExact(path.join(target, relative))) !== hash) {
        throw new Error("В установленном плагине есть ручные изменения. Сохраните их перед обновлением.");
      }
    }
  }

  const privateRoot = path.join(userHome, ".cursor", "monster-automation-private");
  await ensureDirectory(privateRoot);
  await chmod(privateRoot, 0o700);
  const staging = path.join(privateRoot, `install-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  config.mcpServers[pluginName].headers.Authorization = `Bearer ${token}`;
  files.set("mcp.json", json(config));
  const hashes = {};
  for (const [relative, content] of files) {
    await mkdir(path.dirname(path.join(staging, relative)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(staging, relative), content, { mode: 0o600, flag: "wx" });
    hashes[relative] = digest(content);
  }
  // Do not store even a hash of the personal credential in the management marker.
  delete hashes["mcp.json"];
  await writeFile(path.join(staging, markerName), json({ name: pluginName, format: 1, version, files: hashes }), { mode: 0o600 });
  let backup;
  if (existing) {
    backup = path.join(privateRoot, `backup-${randomUUID()}`);
    await rename(target, backup);
  }
  try { await rename(staging, target); }
  catch (error) {
    if (backup) await rename(backup, target);
    throw error;
  }
  return { target, backup, version };
}

export function readHiddenToken(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error("Запустите установщик в интерактивном терминале. Ключ нельзя передавать аргументом или через pipe.");
  output.write("Персональный MCP-ключ (ввод скрыт): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value.trim());
      value = "";
    };
    const onEnd = () => finish(new Error("Ввод ключа прерван."));
    const onError = () => finish(new Error("Ошибка ввода ключа."));
    const onKey = (text, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) return finish(new Error("Установка отменена."));
      if (["return", "enter"].includes(key.name)) return finish();
      if (key.name === "backspace") value = value.slice(0, -1);
      else if (!key.ctrl && !key.meta && text && !text.includes("\u001b")) {
        value += text;
        if (value.length > 256) finish(new Error("Слишком длинный ключ."));
      }
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.includes("--help")) {
    console.log("node install.mjs [--update]\nУстановка плагина в личный Cursor; --update обновляет пакет или заменяет ключ. Ключ вводится скрыто.");
    return;
  }
  if (flags.some((flag) => flag !== "--update")) throw new Error("Допустим только --update. Не передавайте ключ в командной строке.");
  await loadBundle();
  console.log("Monster Automation для Cursor\nКлюч будет сохранён в личном mcp.json плагина, не в проекте. Это локальный файл, не зашифрованное хранилище. Не передавайте установленную папку другим людям.");
  const token = await readHiddenToken();
  const result = await install({ token, update: flags.includes("--update") });
  console.log(`Готово: плагин ${result.version} установлен. Перезапустите Cursor и выберите /ma-help.\nДействительность ключа проверяется MCP при подключении; установщик не выполняет сетевых запросов.`);
  if (result.backup) console.log(`Предыдущая версия сохранена: ${result.backup}\nВ копии есть прежний ключ. После проверки нового ключа отзовите старый в MCP-доступе.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Filesystem/parser errors can contain file contents. Never print them or a stack.
    const safe = error instanceof Error && !error.code && !(error instanceof SyntaxError);
    console.error(safe ? error.message : "Не удалось установить пакет. Проверьте права доступа и целостность файлов; настройки других MCP не изменены.");
    process.exitCode = 1;
  });
}
