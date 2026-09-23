## Introduction

Forked from [opencode-visual-cache](https://github.com/Hotakus/opencode-visual-cache), adding first-token latency (TTFT), generation speed (TPS), and more, with real-time refresh.
> ✅ Updated for opencode v2 compatibility.

<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-cache-and-tps/master/assets/screen_shot_01.png" width="100%"></img>

**Display styles**:
- `/cache-style` — set the bottom info style: Default, DSH, or Minimal.
- `/cache-tps` — set how TPS is calculated. By default it shows output speed; you can switch to perceived speed (opencode's calculation).
- `/cache-bar` — toggle bottom info items. By default it shows Hit rate + Speed + Tools (the Tools item only appears while a tool is being called). All available options: Hit rate / Tokens / Balance / TTFT / Speed / Latency / Tools.

**Included metrics**:
- **TTFT**: Time to first token — perceived time from when the user sends a request (step) to when the first token arrives.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: Model generation time per request (step) — perceived time, excluding tool-call time.
- Errors introduced by OpenCode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).
> Difference from the opencode client's TPS: the client's TPS includes TTFT — it is the perceived time from sending the request to completion of generation, averaged with weights, which is inherently smaller. This plugin's TPS is the provider's token count divided by generation time, taken as the median, which leans toward output speed.

**Real-time TPS estimation**:
- While streaming, the token count is an estimate that varies slightly by model; it is replaced with the exact value once the stream ends.
- Chinese characters: 1.5 chars/token (measured 1.34 on GPT-o200k, 1.52 on DeepSeek-V4).
- ASCII: 4.0 for reasoning streams, 2.9 for answer text, 3.7 for tools & code, 3.3 default for prose.
- Full-width punctuation and full-width characters are counted as 1.

## Installation

For v2, edit `~/.config/opencode/cli.json` and add the package name. Do not use `opencode plugin add`, see the upstream documentation for details.

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

For v1, press `Ctrl + P` in OpenCode to open the command palette, search for `install plugin`, and enter:

```
opencode-cache-and-tps@latest
```

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

MIT
