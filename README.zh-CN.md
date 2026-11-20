# Magpie 渠道性价比

[English](README.md)

在 Magpie 的插件侧栏里，按同一模型比较渠道的估算扣帐、缓存命中和响应速度。默认打开最近 24 小时的 `gpt-6.2-sol`。当窗口里没有这个模型时，改用请求数最多的模型。点击表头切换排序。

## 安装

需要支持 `magpie.page.service` 和 `magpie usage --csv --last` 的 Magpie。可以直接从 GitHub 安装。

```sh
magpie plugin add github:KaranocaVe/magpie-channel-value
```

打开 Magpie 侧栏的「渠道性价比」。如果 Magpie 使用英文，侧栏入口叫 **Channel Value**。页面内容使用简体中文。

## 计费口径

- 倍率默认从名称末尾的小数读取，例如 `relay0.1` 得到 `0.1×`。可在页面底部手动覆盖，清空后恢复按名称读取。已在 Magpie 自定义价格中折入渠道倍率时，手动填 `1`。
- 估算扣帐是 Magpie 的用量成本乘以倍率，价格沿用 Magpie 对输出、长上下文和速度档位的处理。页面统一按当前倍率重算所选时段，无法反映历史倍率变动、充值成本或供应商账单差异。
- 单位扣帐用估算扣帐除以全部输入 token（含缓存读写），再乘一百万。缓存命中率用缓存读取除以已报告缓存情况的输入 token。
- 只比较经本机 Magpie gateway 记录的流量。请求数、失败、取消和速度沿用 Magpie 的统计口径。不同渠道接到的上下文长度、输出量和请求档位，会影响比较结果。少于 50 次请求的最低价会标为小样本。缺少价格的渠道不参与扣帐排名。

插件流式读取 `magpie usage --csv` 的 token 和计价数据，并从本地 gateway 读取渠道名、请求数和速度。两处数据会在同一次刷新中分别采样。页面只收到模型及渠道统计。手动倍率保存在 Magpie 配置目录的 `channel-value-rates.json`。默认服务端口为 `3491`，可用插件选项 `port` 修改。若服务找不到 Magpie CLI，可将插件选项 `magpieBin` 指向 CLI 的绝对路径。
