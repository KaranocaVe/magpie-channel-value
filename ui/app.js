const byId = id => document.getElementById(id);
const token = document.querySelector('meta[name="channel-value-token"]').content;
const root = document.documentElement;
const initialTheme = new URLSearchParams(location.search).get("theme");
const themeTokens = ["bg", "card", "fg", "fg-2", "muted", "line", "accent", "accent-soft", "red", "font", "code"];

if (initialTheme === "light" || initialTheme === "dark") root.style.colorScheme = initialTheme;
if (parent !== window) {
  // The launcher and the service share a WindowProxy. Rejoin the Page
  // bridge after navigating so the service receives live theme changes.
  const themeRequest = "channel-value-theme";
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const message = event.data;
    const theme = message.event === "theme" ? message.data : message.id === themeRequest ? message.result : null;
    if (typeof theme?.dark !== "boolean") return;
    root.style.colorScheme = theme.dark ? "dark" : "light only";
    for (const key of themeTokens) {
      const token = theme.tokens?.[key];
      if (typeof token === "string" && token) root.style.setProperty(`--magpie-${key}`, token);
      else root.style.removeProperty(`--magpie-${key}`);
    }
  });
  parent.postMessage({ magpie: 1, id: themeRequest, method: "hello" }, "*");
}

const periodButtons = Array.from(document.querySelectorAll("[data-period]"));

const state = {
  data: null,
  rates: {},
  model: "gpt-6.2-sol",
  period: "last:24h",
  sort: "unit",
  ascending: true,
  loading: false,
};
const integers = new Intl.NumberFormat("zh-CN");
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const usd = value => "$" + (value > 0 && value < 0.001 ? value.toPrecision(3) : value.toFixed(3));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(new URL(path, location.href), { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function namedRate(name) {
  const suffix = name.trim().match(/(?:^|[^\d.\-])(\d+\.\d+)\s*(?:[×x])?$/i);
  if (!suffix) return null;
  const rate = Number(suffix[1]);
  return rate <= 1000 ? rate : null;
}

function rateFor(provider, name) {
  if (Object.hasOwn(state.rates, provider)) return { value: state.rates[provider], origin: "手动" };
  return { value: namedRate(name), origin: "名称" };
}

function comparison() {
  return state.data.entries.filter(row => row.model === state.model).map(row => {
    const name = state.data.names.get(row.provider) ?? row.provider;
    const rate = rateFor(row.provider, name);
    const prompt = row.input + row.cacheRead + row.cacheWrite;
    const measured = prompt - row.cacheUnknown;
    const total = rate.value !== null && !row.unpriced ? row.baseCost * rate.value : null;
    return {
      ...row,
      name,
      rate,
      prompt,
      total,
      unit: total !== null && prompt ? total * 1e6 / prompt : null,
      hit: measured > 0 ? row.cacheRead / measured : null,
    };
  });
}

function formatRate({ value, origin }) {
  return value === null ? "倍率未配置" : `${value}× · ${origin}`;
}

function drawComparison() {
  if (!state.data) return;
  const all = comparison();
  const shown = all.filter(row => byId("show-all").checked || row.rate.value !== null);
  const cheapest = shown.filter(row => row.unit !== null).sort((a, b) => a.unit - b.unit)[0];
  byId("summary").hidden = !cheapest;
  if (cheapest) {
    byId("winner").textContent = cheapest.name;
    byId("winner-detail").textContent = cheapest.calls < 50 ? `样本较少 · ${integers.format(cheapest.calls)} 次请求` : "";
    byId("winner-price").textContent = `${usd(cheapest.unit)} / 百万输入`;
  }

  shown.sort((a, b) => {
    const left = a[state.sort];
    const right = b[state.sort];
    if (left === null) return right === null ? a.name.localeCompare(b.name) : 1;
    if (right === null) return -1;
    return (state.ascending ? left - right : right - left) || a.name.localeCompare(b.name);
  });
  const channels = byId("channels");
  channels.replaceChildren();
  for (const row of shown) {
    const tr = element("tr");
    tr.classList.toggle("lowest", row === cheapest);
    const provider = element("th");
    provider.scope = "row";
    provider.title = row.provider;
    provider.append(element("strong", row.name), element("small", formatRate(row.rate)));
    const tiers = [];
    if (row.priority) tiers.push(`${integers.format(row.priority)} Priority`);
    if (row.ultrafast) tiers.push(`${integers.format(row.ultrafast)} Ultrafast`);
    if (tiers.length) provider.append(element("small", tiers.join(" · ")));
    tr.append(provider);
    const unit = element("td", row.unit === null ? "—" : usd(row.unit), "cost");
    if (row.unpriced) unit.title = `${row.unpriced} 条记录缺少价格`;
    tr.append(unit, element("td", row.hit === null ? "—" : percent.format(row.hit)));
    const total = element("td", row.total === null ? "—" : usd(row.total));
    total.append(element("small", `${tokens.format(row.prompt)} 输入`));
    total.title = `Magpie 成本 $${row.baseCost.toFixed(3)} · ${integers.format(row.output)} 输出 tokens`;
    const requests = element("td", integers.format(row.calls));
    requests.append(element("small", `失败 ${integers.format(row.errors)} · 取消 ${integers.format(row.canceled)}`));
    if (row.calls < 50) requests.title = "样本较少";
    tr.append(total, requests,
      element("td", row.ttft === null ? "—" : `${(row.ttft / 1000).toFixed(1)} s`),
      element("td", row.decode === null ? "—" : `${row.decode.toFixed(0)} tok/s`));
    channels.append(tr);
  }
  byId("empty").hidden = shown.length > 0;
  byId("as-of").textContent = `更新于 ${time.format(new Date(state.data.updatedAt))}`;
  for (const heading of document.querySelectorAll("[data-sort]")) {
    const button = heading.firstElementChild;
    const indicator = button.querySelector("span");
    indicator?.remove();
    heading.removeAttribute("aria-sort");
    if (heading.dataset.sort === state.sort) {
      heading.setAttribute("aria-sort", state.ascending ? "ascending" : "descending");
      const arrow = element("span", state.ascending ? " ↑" : " ↓");
      arrow.setAttribute("aria-hidden", "true");
      button.append(arrow);
    }
  }
}

function drawRates() {
  const fields = byId("rate-fields");
  fields.replaceChildren();
  for (const { id, name } of state.data.providers.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const input = element("input");
    input.type = "number";
    input.min = "0";
    input.max = "1000";
    input.step = "any";
    input.name = id;
    input.value = Object.hasOwn(state.rates, id) ? String(state.rates[id]) : "";
    const automatic = namedRate(name);
    input.placeholder = automatic === null ? "未配置" : String(automatic);
    const label = element("label");
    label.append(element("span", name), input);
    fields.append(label);
  }
}

function drawModels() {
  const select = byId("model");
  const models = new Map();
  for (const row of state.data.entries) {
    models.set(row.model, (models.get(row.model) ?? 0) + row.calls);
  }
  const options = [...models].sort((a, b) => b[1] - a[1]);
  if (!models.has(state.model)) state.model = options[0]?.[0] ?? "";
  select.replaceChildren(...options.map(([model]) => new Option(model, model)));
  select.value = state.model;
  select.disabled = !options.length;
}

async function load(refresh = false) {
  if (state.loading) return;
  state.loading = true;
  byId("refresh").disabled = true;
  for (const button of periodButtons) {
    button.disabled = true;
    button.setAttribute("aria-pressed", String(button.dataset.period === state.period));
  }
  byId("notice").textContent = "正在读取 Magpie 用量…";
  byId("notice").hidden = false;
  byId("notice").className = "";
  const query = new URLSearchParams({ period: state.period, refresh: refresh ? "1" : "0" });
  try {
    const data = await api(`api/usage?${query}`);
    state.data = { ...data, names: new Map(data.providers.map(({ id, name }) => [id, name])) };
    drawModels();
    if (!byId("rate-panel").open || !byId("rate-fields").children.length) drawRates();
    drawComparison();
    byId("notice").hidden = true;
    byId("results").hidden = false;
  } catch (error) {
    byId("results").hidden = true;
    byId("notice").textContent = error.message;
    byId("notice").className = "error";
  } finally {
    state.loading = false;
    byId("refresh").disabled = false;
    for (const button of periodButtons) button.disabled = false;
  }
}

byId("refresh").addEventListener("click", () => load(true));
for (const button of periodButtons) {
  button.addEventListener("click", () => {
    if (state.loading || state.period === button.dataset.period) return;
    state.period = button.dataset.period;
    load();
  });
}
byId("model").addEventListener("change", event => {
  state.model = event.target.value;
  drawComparison();
});
byId("show-all").addEventListener("change", drawComparison);
for (const heading of document.querySelectorAll("[data-sort]")) {
  heading.firstElementChild.addEventListener("click", () => {
    const sort = heading.dataset.sort;
    state.ascending = state.sort === sort ? !state.ascending : ["unit", "total", "ttft"].includes(sort);
    state.sort = sort;
    drawComparison();
  });
}

byId("save-rates").addEventListener("click", async event => {
  const fields = byId("rate-fields");
  const button = event.currentTarget;
  const status = byId("rate-status");
  button.disabled = true;
  status.classList.remove("error");
  status.textContent = "保存中…";
  try {
    const updates = new Map(Object.entries(state.rates));
    for (const input of fields.querySelectorAll("input")) {
      if (!input.reportValidity()) throw new Error("倍率须在 0 到 1000 之间");
      if (input.value === "") updates.delete(input.name);
      else updates.set(input.name, input.valueAsNumber);
    }
    const { rates } = await api("api/rates", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rates: Object.fromEntries(updates) }),
    });
    state.rates = rates;
    drawRates();
    drawComparison();
    status.textContent = "已保存";
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

async function start() {
  try {
    ({ rates: state.rates } = await api("api/rates"));
    await load();
  } catch (error) {
    byId("notice").textContent = error.message;
    byId("notice").className = "error";
    byId("refresh").disabled = true;
  }
}

start();
