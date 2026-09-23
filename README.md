## 介绍

Fork自opencode-visual-cache，新增首字延迟（TTFT），生成速度（TPS）等信息，支持实时刷新。
> ✅已更新兼容opencode v2。

<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_01.png" width="100%"></img>

**显示样式**：
- `/cache-style`，设置底部信息样式，包括默认、DSH、极简。
- `/cache-tps`，设置TPS的计算方式，默认显示输出速度，可选体感速度（opencode计算方式）。
- `/cache-bar`，设置底部信息开关，默认显示命中率+速度+工具（仅在调用工具时显示），全部选项包括：命中率/Tokens/余额/首字/速度/延迟/工具。

**信息包含**：
- **TTFT**：首字延迟，从用户发出请求（step）到第一个token的体感时间。
- **TPS**：token生成速度（去除工具调用时间）。
- **Latency**：单次请求（step）的模型生成耗时（体感时间，去除工具调用时间）。
- 忽略opencode自动压缩造成的误差，忽略工具暂停（例如提问）时的计数。
> 与opencode客户端tps的差异：客户端tps包含ttft，为发出请求到生成完毕的体感时间，加权平均，天然偏小；本插件的tps为供应商token数除以生成时间，取中位数，偏输出速度。

**实时TPS估算**：
- 流式传输时token数为估算值，不同模型会有偏差，传输结束后替换为精确值。
- 汉字：1.5字/token（GPT-o200k实测1.34，DeepSeek-V4实测1.52）。
- ASCII：思考流4.0，答案文本2.9，工具与代码3.7，散文默认3.3。
- 全角标点与全角字符按1处理。

## 本地构建

`npm run build`，然后复制目标文件到`~/.config/opencode/plugins`。

```powershell
npm run build; $dst = "~\.config\opencode\plugins\opencode-visual-cache"; New-Item -ItemType Directory -Force "$dst\dist" | Out-Null; Copy-Item tui.js "$dst\tui.js" -Force; Copy-Item dist\tui.js "$dst\dist\tui.js" -Force; Copy-Item dist\v2.js "$dst\dist\v2.js" -Force
```

编辑`~/.config/opencode/package.json`，添加依赖。

```jsonc
{
    "type": "module",
    "dependencies": {
        // ...
        "@opentui/solid": "^0.5.1"
    }
}
```

V1需要额外编辑`~/.config/opencode/tui.json`，添加本地TUI插件。

```jsonc
{
    "$schema": "https://opencode.ai/tui.json",
    "plugin": [
        // ...
        "./plugins/opencode-visual-cache/dist/tui.js"
    ]
}
```

V1需要重启opencode，V2自动重载。

## License

MIT
