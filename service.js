import { randomBytes } from "node:crypto";
import { access, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const periods = new Set(["today", "last:24h", "7d", "30d"]);
const assets = new Map([
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function gatewayOrigin() {
  const address = (process.env.MAGPIE_ADDR || "127.0.0.1:3425")
    .replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:");
  const url = new URL(address.includes("://") ? address : `http://${address}`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Channel Value requires a loopback Magpie gateway");
  }
  return url.origin;
}

function totals(row = {}) {
  const number = key => Number.isFinite(row[key]) ? row[key] : 0;
  return {
    calls: number("calls"),
    errors: number("errors"),
    canceled: number("canceled"),
    cacheUnknown: number("cache_unknown"),
    ttft: number("timed") ? number("ttft_ms") / number("timed") : null,
    decode: number("decode_ms") ? number("decode_out") * 1000 / number("decode_ms") : null,
  };
}

async function gatewayStats(gateway, period) {
  const url = new URL("/v1/magpie/usage/requests", gateway);
  url.search = new URLSearchParams({ period, via: "through", limit: "1" });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) throw new Error(`Magpie gateway returned HTTP ${response.status}`);
  const data = await response.json();
  const shares = data.by?.modelAt;
  if (data.period !== period || !Array.isArray(shares)) {
    throw new Error("Magpie did not return per-provider usage for this period");
  }

  const providers = new Map((data.providers ?? []).map(row => [row.id, row.name]));
  for (const row of data.by?.provider ?? []) {
    providers.set(row.id, row.name || providers.get(row.id) || row.id);
  }

  return { providers, groups: new Map(shares.map(row => [row.id, row])) };
}

async function resolveMagpie(configuredPath) {
  if (configuredPath) {
    if (isAbsolute(configuredPath)) return configuredPath;
    throw new Error("插件选项 magpieBin 需要使用绝对路径");
  }
  for (const path of [
    Bun.which("magpie"),
    join(homedir(), ".local", "bin", "magpie"),
    "/Applications/magpie.app/Contents/MacOS/magpie",
  ]) {
    if (path && await access(path).then(() => true, () => false)) return path;
  }
  throw new Error("找不到 Magpie CLI，请在插件选项中设置 magpieBin");
}

// Go's CSV writer can put line breaks and doubled quotes inside error messages.
async function* csvRows(stream) {
  const lines = createInterface({ input: Readable.fromWeb(stream), crlfDelay: Infinity });
  let record = "";
  let quoted = false;
  for await (const line of lines) {
    if (!record && !line) continue;
    record += line;
    if ((line.match(/"/g)?.length ?? 0) % 2) quoted = !quoted;
    if (quoted) {
      record += "\n";
      continue;
    }
    yield Array.from(("," + record).matchAll(/,("(?:[^"]|"")*"|[^,]*)/g), ([, field]) =>
      field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field);
    record = "";
  }
  if (quoted) throw new Error("Magpie CSV 输出不完整");
}

async function cliUsage(magpieBin, period) {
  const cli = await resolveMagpie(magpieBin);
  const window = period === "last:24h" ? ["--last", "24h"] : [period];
  const subprocess = Bun.spawn([cli, "usage", "--csv", ...window], {
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(45000),
  });
  const groups = new Map();
  let index;
  try {
    for await (const record of csvRows(subprocess.stdout)) {
      if (!index) {
        index = Object.fromEntries(record.map((name, i) => [name, i]));
        const required = ["provider", "model", "source", "rejected", "input_tokens", "output_tokens",
          "cache_read_tokens", "cache_write_tokens", "cost_usd"];
        if (!required.every(name => Object.hasOwn(index, name))) throw new Error("当前 Magpie CLI 的用量格式不受支持");
        continue;
      }
      const field = name => record[index[name]];
      if (field("rejected") === "true" || ignoredSources.has(field("source"))) continue;
      const provider = field("provider");
      const model = field("model");
      if (!provider || !model) continue;
      const key = `${provider}/${model}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          baseCost: 0, unpriced: 0, priority: 0, ultrafast: 0,
        };
        groups.set(key, row);
      }
      const input = Number(field("input_tokens"));
      const output = Number(field("output_tokens"));
      const cacheRead = Number(field("cache_read_tokens"));
      const cacheWrite = Number(field("cache_write_tokens"));
      const cost = field("cost_usd");
      row.input += input;
      row.output += output;
      row.cacheRead += cacheRead;
      row.cacheWrite += cacheWrite;
      const tier = field("tier_served");
      if (input + output + cacheRead + cacheWrite && (tier === "priority" || tier === "ultrafast")) row[tier]++;
      if (cost !== "" && Number.isFinite(Number(cost))) row.baseCost += Number(cost);
      else if (input + output + cacheRead + cacheWrite) row.unpriced++;
    }
    if (await subprocess.exited !== 0 || !index) throw new Error("Magpie CLI 未完成用量导出");
    return groups;
  } finally {
    if (subprocess.exitCode === null) subprocess.kill();
  }
}

const ignoredSources = new Set(["log", "reported", "probe", "mcp", "search"]);

async function usage(gateway, magpieBin, period) {
  const [{ providers, groups }, cli] = await Promise.all([gatewayStats(gateway, period), cliUsage(magpieBin, period)]);
  const entries = Array.from(cli, ([key, row]) => {
    if (!providers.has(row.provider)) providers.set(row.provider, row.provider);
    return { ...row, ...totals(groups.get(key)) };
  });
  return {
    period,
    updatedAt: new Date().toISOString(),
    providers: Array.from(providers, ([id, name]) => ({ id, name })),
    entries,
  };
}

function validateRates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的倍率配置");
  const entries = Object.entries(value);
  if (entries.length > 500 || entries.some(([id, rate]) =>
    !id || id.length > 200 || !Number.isFinite(rate) || rate < 0 || rate > 1000)) {
    throw new Error("倍率须在 0 到 1000 之间");
  }
  return Object.fromEntries(entries);
}

async function readRates(file) {
  try {
    return validateRates(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveRates(file, rates) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(rates, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function proxyOrigin(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol) && raw === url.origin &&
        /^[a-zA-Z0-9.:[\]-]+$/.test(url.host)) return url.origin;
  } catch { /* the local service is sufficient for the desktop launcher */ }
  return "";
}

export function startChannelValue({ directory, port = 3491, gateway = gatewayOrigin(), magpieBin }) {
  if (!isAbsolute(directory)) throw new Error("Magpie configuration directory is unavailable");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Channel Value port");
  const ratesPath = join(directory, "channel-value-rates.json");
  const token = randomBytes(32).toString("hex");
  const cache = new Map();

  function snapshot(period, refresh) {
    const previous = cache.get(period);
    if (previous && (previous.pending || (!refresh && Date.now() - previous.started < 15000))) {
      return previous.promise;
    }
    const entry = { pending: true, started: Date.now() };
    entry.promise = usage(gateway, magpieBin, period).then(data => {
      entry.pending = false;
      return data;
    }).catch(error => {
      cache.delete(period);
      throw error;
    });
    cache.set(period, entry);
    return entry.promise;
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 55,
    maxRequestBodySize: 64 * 1024,
    async fetch(request, server) {
      const local = `127.0.0.1:${server.port}`;
      const headers = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      };
      const json = (body, status = 200) => Response.json(body, { status, headers });
      if (request.headers.get("host") !== local) return json({ error: "Host denied" }, 403);
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== "null" && origin !== `http://${local}`) {
          return json({ error: "Origin denied" }, 403);
        }
        if (origin === "null") headers["access-control-allow-origin"] = "null";
        if (request.method === "OPTIONS") {
          headers["access-control-allow-headers"] = "authorization, content-type";
          headers["access-control-allow-methods"] = "GET, PUT, OPTIONS";
          return new Response(null, { status: 204, headers });
        }
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return json({ error: "Reload the page to reconnect" }, 401);
        }
        if (url.pathname === "/api/usage" && request.method === "GET") {
          const period = url.searchParams.get("period") || "last:24h";
          if (!periods.has(period)) return json({ error: "Unsupported period" }, 400);
          try {
            return json(await snapshot(period, url.searchParams.get("refresh") === "1"));
          } catch (error) {
            return json({ error: error.message }, 502);
          }
        }
        if (url.pathname === "/api/rates" && request.method === "GET") {
          try {
            return json({ rates: await readRates(ratesPath) });
          } catch {
            return json({ error: "无法读取渠道倍率配置" }, 500);
          }
        }
        if (url.pathname === "/api/rates" && request.method === "PUT") {
          let rates;
          try {
            rates = validateRates((await request.json()).rates);
          } catch (error) {
            return json({ error: error.message }, 400);
          }
          try {
            await saveRates(ratesPath, rates);
            return json({ rates });
          } catch {
            return json({ error: "无法保存渠道倍率配置" }, 500);
          }
        }
        return json({ error: "Not found" }, 404);
      }

      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const origins = [`http://${local}`, proxyOrigin(url.searchParams.get("uiOrigin"))].filter(Boolean).join(" ");
        const html = await Bun.file(new URL("./ui/index.html", import.meta.url)).text();
        return new Response(html.replace("__PAGE_TOKEN__", token), {
          headers: {
            ...headers,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'none'; script-src 'self' ${origins}; style-src 'self' ${origins}; connect-src 'self' ${origins}; base-uri 'none'; form-action 'none'`,
          },
        });
      }
      const asset = assets.get(url.pathname);
      if (!asset) return json({ error: "Not found" }, 404);
      return new Response(Bun.file(new URL(`./ui/${asset[0]}`, import.meta.url)), {
        headers: { ...headers, "content-type": asset[1] },
      });
    },
  });
}

let service;

export default {
  id: "magpie-page-channel-value",
  server(input, options = {}) {
    service ??= startChannelValue({
      directory: input.directory,
      port: Number(options.port ?? 3491),
      magpieBin: options.magpieBin,
    });
    return {};
  },
};
