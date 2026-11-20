# Channel Value for Magpie

[简体中文](README.zh-CN.md)

A Magpie page for comparing providers that serve the same model. Rank them by estimated debit per million prompt tokens, then compare cache hit rate, request volume, time to first token, generation speed, and Priority or Ultrafast usage.

## Install

Use a Magpie build that supports `magpie.page.service` and `magpie usage --csv --last`.

```sh
magpie plugin add github:KaranocaVe/magpie-channel-value
```

Open **Channel Value** in the Plugins section of Magpie's sidebar. The page is in Simplified Chinese. It starts with the last 24 hours and selects `gpt-6.2-sol` if present, or the model with the most requests.

## How costs are estimated

The page multiplies the cost reported by the Magpie CLI by the provider multiplier. A decimal suffix such as `relay0.1` sets a multiplier of 0.1. You can override it in the page, or set it to 1 if Magpie's configured pricing already includes the discount.

The per-million figure divides estimated debit by all prompt tokens, including cache reads and writes. The current multiplier applies to the entire reporting window. The estimate reflects the traffic each provider received, including output volume and speed tiers, and can differ from the provider's invoice.

The page service listens on loopback port 3491 by default and reads the local CLI and gateway. See the [Chinese README](README.zh-CN.md) for configuration details.
