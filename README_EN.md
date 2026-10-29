## Introduction

Forked from [opencode-visual-cache](https://github.com/Hotakus/opencode-visual-cache), it presents cache hits (Cache), generation speed (TPS), first-token latency (TTFT), and other information in one unified view, with real-time refresh.
> ✅ Updated for opencode v2 compatibility.

<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-cache-and-tps/master/assets/screen_shot_01.png" width="100%"></img>

**Display styles**:
- `/cache-style` — set the bottom info style: Default, DSH, or Minimal.
- `/cache-tps` — set how TPS is calculated. By default it shows output speed; you can switch to perceived speed (opencode's calculation).
- `/cache-bar` — toggle bottom info items. By default it shows Hit rate + Speed + Tools (the Tools item only appears while a tool is being called). All available options: Hit rate / Tokens / Balance / TTFT / Speed / Latency / Tools.
- `/cache-lang` — set the display language: Chinese, English, Japanese, or Korean.

**Included metrics**:
- From the original plugin: cache hits, token usage, balance, sidebar, and more.
- Added: first-token latency, generation speed, generation time, and tool-call time.
- Errors introduced by OpenCode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).
> Difference from the opencode client's TPS: the client's TPS includes TTFT — it is the perceived time from sending the request to completion of generation, averaged with weights, which is inherently smaller. This plugin's TPS is the provider's token count divided by generation time, taken as the median, which leans toward output speed.

## Installation

For v2, edit `~/.config/opencode/cli.json` and add the package name.

> Do not use `opencode plugin add`; see the upstream documentation for details.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-cache-and-tps@latest",
      "options": {
        "enabled": true
      }
    }
  ]
}
```

For v1, edit `~/.config/opencode/tui.json` and add the package name.

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    // ...
    "opencode-cache-and-tps@latest"
  ]
}
```

Forced update: delete the cache to force the plugin to update. The v2 cache is at `~/.cache/opencode/npm`; the v1 cache is at `~/.cache/opencode/packages`.

## Local Build

Run `npm run build`, then copy the artifacts to `~/.config/opencode/plugins`.

```powershell
npm run build; $dst = "~\.config\opencode\plugins\opencode-cache-and-tps"; New-Item -ItemType Directory -Force "$dst\dist" | Out-Null; Copy-Item tui.js "$dst\tui.js" -Force; Copy-Item dist\tui.js "$dst\dist\tui.js" -Force; Copy-Item dist\v2.js "$dst\dist\v2.js" -Force
```

Edit `~/.config/opencode/package.json` to add the dependency.

```jsonc
{
  "type": "module",
  "dependencies": {
    // ...
    "@opentui/solid": "^0.5.1"
  }
}
```

For v1 you also need to edit `~/.config/opencode/tui.json` to add the local TUI plugin.

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    // ...
    "./plugins/opencode-cache-and-tps/dist/tui.js"
  ]
}
```

v1 requires restarting opencode; v2 reloads automatically.

## License

MIT@Hotakus
