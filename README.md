# libretv-sources

自建的 LibreTV 源清单，每天由 GitHub Actions 自动采集、实测、更新。产物：

| 文件 | 用途 |
| --- | --- |
| `libretv-sources.json` | LibreTV 订阅地址（标准 LibreTV-SourceList 格式） |
| `live/merged.m3u` | 聚合后的直播 M3U（多源去重合并，LibreTV 直接订阅） |

订阅 raw 地址：

```
https://raw.githubusercontent.com/erxuw196/libretv-sources/main/libretv-sources.json
```

## 工作方式

1. **点播**：拉取 `config/inputs.json` 里配置的 Apple CMS 列表（lubin776、0.12yue），只保留 JSON 接口，按域名去重，
   再逐个请求 `?ac=videolist&wd=庆余年`，要求 `code=1`、列表非空且带 `vod_play_url`，通过的才收录（上限 100）。
2. **直播**：保留人工筛选的特色源（虎牙/B站/斗鱼/iptv-org 各国等），同时把 livelist 中每个 M3U 订阅解析成频道，
   跨源按地址去重后合并成 `live/merged.m3u`；列表级失效会被自动跳过。
3. 每天 UTC 19:00 跑一次，也可在 Actions 页手动 `Run workflow`。

## 自定义

编辑 `config/inputs.json`：

- `vodUpstreams`：点播列表地址（`名称|别名|type: 1|api: URL` 格式）
- `liveUpstreams`：直播订阅列表（`文件名|日期|大小|M3U地址|...` 格式）
- `vodSeed` / `liveCurated`：想无条件优先保留的源
- `limits`：`vod` 上限、`live` 上限、聚合频道数上限

改完提交，下一次运行即生效。
