#!/usr/bin/env node
/**
 * Скрапер erotorrent.org -> JSON-источник для Hydra Launcher
 *
 * Собирает раздачи с сайта и генерирует JSON формата Hydra:
 *
 * {
 *   "name": "...",
 *   "downloads": [
 *     { "title": "...", "uris": ["magnet:?xt=urn:btih:...", "https://pixeldrain.com/u/..."],
 *       "uploadDate": "...", "fileSize": "..." }
 *   ]
 * }
 *
 * Особенность erotorrent.org: раздача может быть оформлена как .torrent,
 * так и ссылкой на облако (pixeldrain / Google Drive / mega.nz).
 * Hydra поддерживает ограниченный набор хостеров, поэтому:
 *  - .torrent скачивается, вычисляется infohash v1, строится magnet;
 *  - pixeldrain.com/u/<id> кладётся в uris как есть (Hydra умеет);
 *  - Google Drive / mega.nz и прочие Hydra НЕ умеет — они пропускаются
 *    с предупреждением в логе (иначе Hydra отфильтрует всю игру целиком).
 *
 * Использование:
 *   node scrape.mjs                 # страницы новостей (3 по умолчанию)
 *   node scrape.mjs --pages 5       # 5 страниц новостей
 *   node scrape.mjs --all           # ВЕСЬ сайт через sitemap (долго!)
 *   node scrape.mjs --all --limit 500  # до 500 НОВЫХ игр за запуск
 *   node scrape.mjs --check-updates --updates-limit N --refresh
 *                                   # проверка N закэшированных игр на обновление
 *   node scrape.mjs --full          # легаси-флаг: перечитать кэшированные в news-режиме
 *
 * Обнаружение обновлений: у каждой игры в кэше хранится отпечаток
 * (размер + дата + версия + название + тип раздачи). Изменился — репак
 * обновился на сайте, ссылки перекачиваются (в паре с --refresh).
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BASE = "https://erotorrent.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const OUT_FILE = "erotorrent.json";
const CACHE_DIR = ".cache";
const CACHE_FILE = path.join(CACHE_DIR, "downloads.json");

// Лимиты вежливости: сайт не наш, не долбим его запросами
const PAGE_DELAY_MS = 1500; // пауза между страницами
const TORRENT_DELAY_MS = 700; // пауза между скачиванием .torrent
const MAX_TORRENT_RETRIES = 2;

// Хостеры облаков, которые Hydra умеет качать напрямую (см. getDownloadersForUri
// в исходниках Hydra). Всё остальное из блока релиза отфильтровываем.
const SUPPORTED_CLOUD_HOSTS = ["pixeldrain.com"];
const TORRENT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const ALL = args.includes("--all");
const CHECK_UPDATES = args.includes("--check-updates");
const limitArgIdx = args.indexOf("--limit");
const ALL_LIMIT = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1], 10) || 0 : 0;
const updArgIdx = args.indexOf("--updates-limit");
const UPDATE_LIMIT = updArgIdx !== -1 ? parseInt(args[updArgIdx + 1], 10) || 0 : 0;
const REFRESH = args.includes("--refresh");
const pagesArgIdx = args.indexOf("--pages");
const MAX_PAGES = pagesArgIdx !== -1 ? parseInt(args[pagesArgIdx + 1], 10) || 3 : 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { URL } from "node:url";

const PROXY =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.SCRAPER_PROXY ||
  null;

if (PROXY) {
  const sanitized = PROXY.replace(/:[^:@]+@/, ":***@");
  console.log(`[proxy] включен прокси: ${sanitized}`);
}

/** Внутренний запрос с поддержкой HTTP/HTTPS прокси (CONNECT tunneling) без npm-зависимостей */
function rawRequest(url, { headers = {}, timeout = 30000 } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const onResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        cleanup();
        const nextUrl = new URL(res.headers.location, target).toString();
        return rawRequest(nextUrl, { headers, timeout }).then(resolve, reject);
      }
      cleanup();
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          buffer: () => Promise.resolve(buf),
          text: (enc = "utf-8") => Promise.resolve(buf.toString(enc)),
        });
      });
    };

    if (PROXY) {
      const p = new URL(PROXY);
      const isProxyHttps = p.protocol === "https:";
      const proxyLib = isProxyHttps ? https : http;
      const targetPort = target.port || (isHttps ? 443 : 80);

      const connectReq = proxyLib.request({
        host: p.hostname,
        port: p.port || (isProxyHttps ? 443 : 80),
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: {
          Host: `${target.hostname}:${targetPort}`,
          ...(p.username
            ? {
                "Proxy-Authorization":
                  "Basic " +
                  Buffer.from(
                    decodeURIComponent(p.username) + ":" + decodeURIComponent(p.password)
                  ).toString("base64"),
              }
            : {}),
        },
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          connectReq.destroy(new Error(`Timeout connecting via proxy (${timeout}ms)`));
        }, timeout);
      }

      connectReq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          cleanup();
          socket.destroy();
          return reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
        }

        if (isHttps) {
          const tlsSocket = tls.connect(
            {
              host: target.hostname,
              socket,
              servername: target.hostname,
            },
            () => {
              const req = https.request(
                target,
                {
                  headers,
                  createConnection: () => tlsSocket,
                },
                onResponse
              );
              req.on("error", (err) => {
                cleanup();
                reject(err);
              });
              req.end();
            }
          );
          tlsSocket.on("error", (err) => {
            cleanup();
            reject(err);
          });
        } else {
          const req = http.request(
            target,
            {
              headers,
              createConnection: () => socket,
            },
            onResponse
          );
          req.on("error", (err) => {
            cleanup();
            reject(err);
          });
          req.end();
        }
      });

      connectReq.on("error", (err) => {
        cleanup();
        reject(err);
      });
      connectReq.end();
    } else {
      const lib = isHttps ? https : http;
      const req = lib.request(target, { headers }, onResponse);
      if (timeout > 0) {
        timer = setTimeout(() => {
          req.destroy(new Error(`Timeout (${timeout}ms)`));
        }, timeout);
      }
      req.on("error", (err) => {
        cleanup();
        reject(err);
      });
      req.end();
    }
  });
}

/** fetch текста с браузерным UA, таймаутом и поддержкой прокси */
async function fetchText(url, { encoding = "utf-8", timeout = 30000, referer, headers = {} } = {}) {
  const reqHeaders = {
    ...DEFAULT_HEADERS,
    ...(referer ? { Referer: referer } : {}),
    ...headers,
  };
  const res = await rawRequest(url, { headers: reqHeaders, timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text(encoding);
}

/**
 * bencode-декодер + поиск info-словаря.
 * Не нужен полноценный парсер: достаточно найти ключ "4:info" и
 * прочитать ровно один bencode-объект с этой позиции.
 */
function decodeBencodeAt(buf, offset) {
  const c = buf[offset];
  if (c === 0x64) {
    // 'd' — словарь
    const dict = {};
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [key, nextPos] = decodeBencodeAt(buf, pos);
      const [val, afterVal] = decodeBencodeAt(buf, nextPos);
      dict[key.toString("latin1")] = val;
      pos = afterVal;
    }
    return [dict, pos + 1];
  }
  if (c === 0x6c) {
    // 'l' — список
    const list = [];
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [val, nextPos] = decodeBencodeAt(buf, pos);
      list.push(val);
      pos = nextPos;
    }
    return [list, pos + 1];
  }
  if (c === 0x69) {
    // 'i' — число
    const end = buf.indexOf(0x65, offset);
    return [parseInt(buf.slice(offset + 1, end).toString(), 10), end + 1];
  }
  // строка: <длина>:<байты>
  const colon = buf.indexOf(0x3a, offset);
  const len = parseInt(buf.slice(offset, colon).toString(), 10);
  const start = colon + 1;
  return [buf.slice(start, start + len), start + len];
}

/** infohash v1 из .torrent (sha1 от bencode-словаря info) */
function computeInfohash(buf) {
  const colon = buf.indexOf(Buffer.from("4:info"));
  if (colon === -1) return null;
  const infoStart = colon + "4:info".length;
  try {
    const [, infoEnd] = decodeBencodeAt(buf, infoStart);
    return createHash("sha1").update(buf.subarray(infoStart, infoEnd)).digest("hex");
  } catch {
    return null;
  }
}

/** Вытащить список ссылок на страницы-игры со страницы новостей */
function extractGameLinks(html) {
  const links = new Set();
  // Ссылки вида https://erotorrent.org/<категория>/1234-game-name.html
  const re = /https?:\/\/erotorrent\.org\/[a-z0-9-]+\/(\d+)-[a-z0-9-]+\.html/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.add(m[0]);
  }
  return [...links];
}

/** Вытащить заголовок игры из страницы */
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  // "Скачать <Название> торрент бесплатно" -> чистим мусор
  return m[1]
    .replace(/^.*?скачать\s*/i, "")
    .replace(/\s*торрент\s*(бесплатно)?\s*$/i, "")
    .trim();
}

/**
 * Блоки релизов: каждый release — <div class="main_file">...</div>
 * Внутри: версия (bold_1), размер ("Размер: 4.15 GB") и кнопки скачивания:
 *  - торрент: <a href=".../index.php?do=download&id=N" data-ofga-link>
 *  - облако:  <a href="https://pixeldrain.com/u/XXXX" ... data-ofga-link>
 * Берём ПОСЛЕДНИЙ блок main_file на странице — на erotorrent это самый
 * свежий релиз игры (порядок: новые сверху).
 */
function extractRelease(html) {
  const blockRe = /class="main_file"[\s\S]*?(?=<div class="main_file"|$)/gi;
  const blocks = [...html.matchAll(blockRe)].map((m) => m[0]);
  if (!blocks.length) return null;
  const block = blocks[blocks.length - 1];

  const versionMatch = block.match(/class="file_left_1 bold_1">([^<]+)</);
  const sizeMatch = block.match(/\u0420\u0430\u0437\u043c\u0435\u0440:\s*([^<]+)</); // "Размер: ..."
  const torrentMatch = block.match(
    /href="(https?:\/\/erotorrent\.org\/index\.php\?do=download&id=\d+)"/i
  );
  const rawCloudUrls = [
    ...block.matchAll(/<a href="(https?:\/\/(?!erotorrent)[^"]+)"[^>]*data-ofga-link/gi),
  ].map((m) => m[1]);

  // Запасные ссылки (например, "Запасная ссылка: PIXELDRAIN - ..."), которые сайт
  // оформляет через DLE redirect: /index.php?do=go&url=<base64>
  const dleMatches = [
    ...block.matchAll(/(?:do=go&amp;url=|do=go&url=)([a-zA-Z0-9+/=]+)/gi),
  ].map((m) => m[1]);

  for (const b64 of dleMatches) {
    try {
      const decoded = Buffer.from(decodeURIComponent(b64), "base64").toString("utf-8");
      if (/^https?:\/\//i.test(decoded)) {
        rawCloudUrls.push(decoded);
      }
    } catch {
      /* игнор некорректного base64 */
    }
  }

  // Оставляем только уникальные облака, которые Hydra умеет качать (например, pixeldrain /u/<id>).
  // Google Drive / mega.nz / uploadhaven и прочее отбрасываем: Hydra отфильтрует
  // весь релиз целиком, если неподдерживаемая ссылка попадёт в uris.
  const cloudLinks = [];
  const seenCloud = new Set();
  for (const url of rawCloudUrls) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      // pixeldrain: поддерживается только файл /u/<id>, папки /l/ отбрасываем
      if (host === "pixeldrain.com" && !parsed.pathname.startsWith("/u/")) {
        continue;
      }
      if (SUPPORTED_CLOUD_HOSTS.includes(host)) {
        if (!seenCloud.has(url)) {
          seenCloud.add(url);
          cloudLinks.push(url);
        }
      } else {
        console.warn(`    [cloud] пропуск неподдерживаемого Hydra хостера: ${host}`);
      }
    } catch {
      /* мусорная ссылка — игнор */
    }
  }

  return {
    version: versionMatch ? versionMatch[1].trim() : null,
    size: sizeMatch ? normalizeSize(sizeMatch[1]) : null,
    torrentUrl: torrentMatch ? torrentMatch[1] : null,
    cloudLinks,
  };
}

/** Нормализация размера: кириллические юниты к латинице, "2.5 G" -> "2.5 GB" */
function normalizeSize(raw) {
  return raw
    .replace(",", ".")
    .replace(/\u0413\u0411/g, "GB") // ГБ -> GB
    .replace(/\u041c\u0411/g, "MB") // МБ -> MB
    .replace(/\u041a\u0411/g, "KB") // КБ -> KB
    .replace(/\bG\b(?!\w)/, "GB")
    .replace(/\bM\b(?!\w)/, "MB")
    .replace(/\bK\b(?!\w)/, "KB")
    .trim();
}

/** Дата публикации/обновления из страницы ("10 сен. 2026, 18:05", "Вчера, 10:11") */
const MONTHS = {
  "января": "01", "февраля": "02", "марта": "03", "апреля": "04",
  "мая": "05", "июня": "06", "июля": "07", "августа": "08",
  "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
  "янв": "01", "фев": "02", "мар": "03", "апр": "04", "мая": "05",
  "июн": "06", "июл": "07", "авг": "08", "сен": "09", "окт": "10",
  "ноя": "11", "дек": "12",
};
function extractDate(html, cache) {
  const m = html.match(
    /(\d{1,2})\s+([а-я]+\.?)\s+(\d{4})(?:,)?\s*(\d{1,2}:\d{2})?/i
  );
  if (m) {
    const month = MONTHS[m[2].replace(".", "").toLowerCase()];
    if (month) {
      const day = m[1].padStart(2, "0");
      const time = m[4] || "00:00";
      return `${m[3]}-${month}-${day} ${time}`;
    }
  }
  // Относительные даты («Сегодня», «Вчера») распарсить нельзя —
  // оставляем прошлое значение из кэша, чтобы не терять дату совсем.
  return cache?.uploadDate || "";
}

async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Все страницы игр из sitemap'а сайта (с fallback'ом на обход страниц при 403/ошибке) */
async function loadSitemapGameUrls() {
  const urls = new Set();
  process.stdout.write("sitemap news_pages.xml... ");
  try {
    const xml = await fetchText(`${BASE}/news_pages.xml`, { timeout: 120000 });
    const found = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    const games = found.filter((u) => /\/\d+-[a-z0-9-]+\.html$/i.test(u));
    games.forEach((u) => urls.add(u));
    console.log(`+${games.length}`);
  } catch (e) {
    console.log(`ошибка: ${e.message}`);
  }

  // Если sitemap заблокирован (например, Cloudflare 403 на GitHub Actions),
  // пробуем sitemap.xml или запасной обход страниц каталога
  if (!urls.size) {
    process.stdout.write("пробуем sitemap.xml... ");
    try {
      const xml = await fetchText(`${BASE}/sitemap.xml`, { timeout: 60000 });
      const found = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
      const subSitemaps = found.filter((u) => u.endsWith(".xml") && !u.endsWith("news_pages.xml"));
      for (const sm of subSitemaps) {
        try {
          const subXml = await fetchText(sm, { timeout: 60000 });
          const smGames = [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)]
            .map((m) => m[1])
            .filter((u) => /\/\d+-[a-z0-9-]+\.html$/i.test(u));
          smGames.forEach((u) => urls.add(u));
        } catch {
          /* игнор ошибок в под-sitemap */
        }
      }
      console.log(`+${urls.size}`);
    } catch (e) {
      console.log(`ошибка: ${e.message}`);
    }
  }

  // Если sitemap полностью заблокирован антиботом, собираем ссылки через пагинацию сайта
  if (!urls.size) {
    console.log("Sitemap недоступен, собираем ссылки через пагинацию сайта...");
    try {
      const firstHtml = await fetchText(`${BASE}/`);
      const pageNums = [...firstHtml.matchAll(/\/page\/(\d+)\//g)].map((m) => parseInt(m[1], 10));
      const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
      console.log(`Всего страниц каталога: ~${maxPage}`);

      for (let p = 1; p <= maxPage; p++) {
        const pageUrl = p === 1 ? `${BASE}/` : `${BASE}/page/${p}/`;
        try {
          const html = p === 1 ? firstHtml : await fetchText(pageUrl);
          const links = extractGameLinks(html);
          links.forEach((u) => urls.add(u));
          if (p % 10 === 0 || p === maxPage) {
            console.log(`  [пагинация] страница ${p}/${maxPage}: всего игр найдено ${urls.size}`);
          }
          if (p > 1) await sleep(500);
        } catch (err) {
          console.warn(`  [пагинация] ошибка на странице ${p}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`  [пагинация] не удалось прочитать главную: ${err.message}`);
    }
  }

  return [...urls];
}

async function downloadTorrent(url) {
  for (let attempt = 0; attempt <= MAX_TORRENT_RETRIES; attempt++) {
    try {
      const res = await rawRequest(url, {
        headers: {
          "User-Agent": UA,
          Referer: BASE + "/",
        },
        timeout: 60000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.buffer();
      // Проверяем что это действительно bencode (начинается с d...e или цифры)
      const first = buf[0];
      if (buf.length < 50 || (first !== 0x64 && !(first >= 0x30 && first <= 0x39))) {
        throw new Error("not a torrent file");
      }
      return buf;
    } catch (e) {
      if (attempt === MAX_TORRENT_RETRIES) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/**
 * Обработать одну страницу игры: спарсить блок релиза, скачать .torrent,
 * построить magnet (+ / или облако), положить в кэш.
 * Возвращает true если игра новая.
 */
async function processGamePage(link, cache, entries) {
  const alreadyHave = Boolean(cache[link]?.uris?.length);

  // В режиме --all кэшированные игры пропускаем мгновенно: их целостность
  // (актуальность ссылок) проверяет отдельный цикл --check-updates.
  if (alreadyHave && ALL && !FULL) {
    entries.set(link, cache[link]);
    return false; // уже есть
  }

  // Обычный/news-режим: страницу всё равно читаем — она свежая; для кэшированной
  // игры это заодно проверка обновления (отпечаток ниже).
  await sleep(PAGE_DELAY_MS);
  let gameHtml;
  try {
    gameHtml = await fetchText(link);
  } catch (e) {
    console.warn(`  ${link}: ${e.message}`);
    return false;
  }

  const title = extractTitle(gameHtml);
  if (!title) return false;

  const release = extractRelease(gameHtml);
  const uploadDate = extractDate(gameHtml, cache[link]);
  const fileSize = release?.size || cache[link]?.fileSize || "";
  const version = release?.version || cache[link]?.version || "";

  const cached = cache[link];

  // ===== Проверка обновления у уже известной игры =====
  if (cached?.uris?.length) {
    const fingerprint = `${fileSize}|${uploadDate}|${version}|${title}|${release?.torrentUrl ? "T" : "C"}`;
    const cachedFingerprint = `${cached.fileSize}|${cached.uploadDate}|${cached.version || ""}|${cached.title}|${cached._torrentUrl ? "T" : "C"}`;
    if (fingerprint === cachedFingerprint) {
      // Ничего не изменилось
      entries.set(link, { ...cached, title, uploadDate, fileSize, version });
      return false;
    }

    if (!REFRESH) {
      // Изменение заметили, но перекачивать не разрешено — просто фиксируем метаданные
      entries.set(link, { ...cached, title, uploadDate, fileSize, version });
      cache[link] = entries.get(link);
      return false;
    } // eslint-disable-line -- (кэш хранит version, JSON — нет)

    console.log(
      `  ~ ${title}: обновление на сайте (${cached.fileSize || "?"} -> ${fileSize || "?"}), перекачиваем ссылки...`
    );
    updatedTorrents++;
    // дальше — общий путь: скачиваем .torrent и перезаписываем ссылки
  }

  const uris = [];

  // 1) Облако (только поддерживаемые Hydra хостеры, см. extractRelease)
  uris.push(...(release?.cloudLinks || []));

  // 2) Торрент: скачать .torrent, вычислить infohash, построить magnet
  let infohash = null;
  if (release?.torrentUrl) {
    await sleep(TORRENT_DELAY_MS);
    let buf;
    try {
      buf = await downloadTorrent(release.torrentUrl);
    } catch (e) {
      console.warn(`  ${title}: .torrent не скачался (${e.message})`);
    }
    if (buf) {
      infohash = computeInfohash(buf);
      if (!infohash) {
        console.warn(`  ${title}: не удалось вычислить infohash`);
      } else {
        const tr = TORRENT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
        uris.push(`magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}${tr}`);
      }
    }
  }

  if (!uris.length) {
    console.warn(`  ${title}: нет ни торрента, ни поддерживаемого облака (пропуск)`);
    return false;
  }

  const entry = {
    title,
    uris,
    uploadDate,
    fileSize,
    version,
    _torrentUrl: release?.torrentUrl || null, // внутреннее поле, удаляется перед записью
  };
  entries.set(link, entry);
  cache[link] = entry;
  if (cached?.uris?.length) {
    console.log(`  ~ ${title}: ссылки обновлены${infohash ? ` [${infohash}]` : ""}`);
  } else {
    console.log(`  + ${title} [${uris.length === 1 && infohash ? infohash : uris.join(" | ")}]`);
  }
  return !cached?.uris?.length; // новая = true, обновление = false
}

let updatedTorrents = 0; // счётчик обновлённых записей (растёт при перекачке)

async function main() {
  const cache = await loadCache(); // { pageUrl: { title, uris, uploadDate, fileSize, version } }
  const entries = new Map();
  for (const [url, data] of Object.entries(cache)) {
    entries.set(url, data);
  }

  let pagesRead = 0;
  let newGames = 0;
  let skippedByCache = 0;

  if (ALL) {
    // ===== Режим --all: весь сайт через sitemap =====
    // Стратегия «сначала новые»: кэшированные пропускаются мгновенно,
    // поэтому за каждый запуск успеваем обработать BATCH игр из начала очереди.
    const gameUrls = await loadSitemapGameUrls();
    const uncachedCount = gameUrls.filter((u) => !cache[u]?.uris?.length || FULL).length;
    const batch = ALL_LIMIT > 0 ? Math.min(ALL_LIMIT, gameUrls.length) : gameUrls.length;
    console.log(`Режим --all: игр в sitemap: ${gameUrls.length}, без кэша: ${uncachedCount}, лимит за запуск: ${batch}`);
    console.log(
      `Оценка времени на новые игры: ~${Math.ceil((Math.min(batch, uncachedCount) * (PAGE_DELAY_MS + TORRENT_DELAY_MS)) / 3600000)} ч\n`
    );
    let done = 0;
    let processed = 0;
    for (const link of gameUrls) {
      // Ограничиваем работу за запуск: считаем только реально обработанные,
      // кэшированные пропускаем бесплатно и не тратим лимит
      if (ALL_LIMIT > 0 && processed >= ALL_LIMIT) {
        console.log(`[--all] лимит ${ALL_LIMIT} новых игр за запуск достигнут, останавливаемся`);
        break;
      }
      done++;
      if (done % 50 === 0) {
        console.log(`[--all] прогресс: ${done}/${gameUrls.length} (новых: ${newGames})`);
        // Периодически сохраняем кэш, чтобы прогресс не терялся при падении
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        const isNew = await processGamePage(link, cache, entries);
        if (isNew) {
          newGames++;
          processed++;
        } else {
          skippedByCache++;
        }
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
  }

  // ===== Обычный режим: страницы новостей =====
  if (!ALL) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageUrl = page === 1 ? BASE + "/" : `${BASE}/page/${page}/`;
      console.log(`[page ${page}] ${pageUrl}`);
      let html;
      try {
        html = await fetchText(pageUrl);
      } catch (e) {
        console.warn(`  не удалось загрузить: ${e.message}`);
        if (page === 1) process.exit(1); // без главной делать нечего
        break; // вероятно, страницы кончились
      }
      pagesRead++;

      const gameLinks = extractGameLinks(html);
      console.log(`  найдено игр: ${gameLinks.length}`);

      for (const link of gameLinks) {
        if (!FULL && cache[link]?.uris?.length) {
          // Уже есть в кэше — берём без повторного скачивания
          entries.set(link, cache[link]);
          skippedByCache++;
          continue;
        }

        const isNew = await processGamePage(link, cache, entries);
        if (isNew) newGames++;
      }
    }
  } // end if (!ALL)

  // ===== Проверка обновлений (--check-updates): читаем страницы у кэшированных
  // игр, сравниваем отпечаток (размер|дата|версия|название|тип), при изменении
  // перекачиваем ссылки. Обрабатываем порцию в начале списка (от свежих к
  // старым), чтобы лимит/таймаут не мешали регулярности проверки.
  if (CHECK_UPDATES) {
    const gameUrls = await loadSitemapGameUrls();
    // только игры, которые уже в кэше
    const cachedUrls = gameUrls.filter((u) => cache[u]?.uris?.length);
    const slice = UPDATE_LIMIT > 0 ? cachedUrls.slice(0, UPDATE_LIMIT) : cachedUrls;
    console.log(`\n[check-updates] игр в кэше: ${cachedUrls.length}, проверяем за запуск: ${slice.length}`);

    let checked = 0;
    for (const link of slice) {
      checked++;
      if (checked % 50 === 0) {
        console.log(`[check-updates] прогресс: ${checked}/${slice.length} (обновлено: ${updatedTorrents})`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        await processGamePage(link, cache, entries);
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
    console.log(`[check-updates] проверено: ${checked}, обновлено: ${updatedTorrents}`);
  }

  // Собираем итоговый JSON. Внутренние поля (_torrentUrl, version) не пишем:
  // Hydra парсит источник на своей стороне, поэтому формат записи строго
  // title/uris/uploadDate/fileSize — ровно как в рабочем формате byrut-источника.
  const downloads = [...entries.values()]
    .map(({ _torrentUrl, version, ...rest }) => rest)
    .filter((d) => d.uris?.length)
    .sort((a, b) => (b.uploadDate || "").localeCompare(a.uploadDate || ""));

  const json = {
    name: "EroTorrent",
    downloads,
  };

  await writeFile(OUT_FILE, JSON.stringify(json, null, 2), "utf-8");
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");

  console.log(
    `\nГотово. Страниц прочитано: ${pagesRead}. Из кэша: ${skippedByCache}. Новых игр: ${newGames}. Обновлено: ${updatedTorrents}.`
  );
  console.log(`Записей в итоговом файле: ${downloads.length} -> ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
