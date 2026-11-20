async function openChannelValue() {
  const theme = await window.magpie.ready;
  const options = await window.magpie.options.get();
  const port = Number(options?.port ?? 3491);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("插件端口无效");

  const localWindow = location.protocol === "wails:" || location.hostname === "wails.localhost";
  if (!window.magpie.service && !localWindow) {
    throw new Error("当前 Magpie Web 版本没有提供页面服务地址");
  }

  const url = new URL(window.magpie.service || `http://127.0.0.1:${port}/`);
  url.searchParams.set("theme", theme.dark ? "dark" : "light");
  url.searchParams.set("lang", theme.lang || "zh");
  if (window.magpie.service) url.searchParams.set("uiOrigin", url.origin);

  setTimeout(() => {
    document.getElementById("status").textContent =
      "渠道性价比服务未响应。请检查插件是否已启用，以及它的本地端口是否可用。";
  }, 4500);
  location.replace(url.href);
}

openChannelValue().catch(error => {
  document.getElementById("status").textContent = error.message;
});
