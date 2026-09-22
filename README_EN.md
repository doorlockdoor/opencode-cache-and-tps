## Introduction

Forked from opencode-visual-cache, adding time to first token (TTFT), generation speed (TPS), and other metrics, with real-time refresh support.
> ✅ Updated for opencode v2 compatibility.

<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_01.png" width="100%"></img>

**Display styles**:
- `/cache-style` — set the style of the bottom info segments, including Default, DSH, and Minimal.
- `/cache-bar` — toggle the bottom info segments. By default it shows hit rate + speed + tool (only while tools are called). All options include: hit rate / Tokens / balance / first token / speed / latency / tool.

**Included metrics**:
- **TTFT**: Time to first token — the perceived time from when the user sends a request (step) to the first token.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: The model's generation time for a single request (step) — perceived time, excluding tool-call time.
- Errors caused by opencode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).
> Difference from the OpenCode client's tps: the client's tps includes ttft — it is the perceived time from sending a request to the completion of generation, a weighted average that is naturally lower; this plugin's tps is the provider's token count divided by generation time, taking the median, and reflects output speed.

**Real-time TPS estimation**:
- While streaming, the token count is an estimate that varies by model; it is replaced with the exact value once the stream ends.
- Chinese characters: 1.5 chars/token (measured 1.34 on GPT-o200k, 1.52 on DeepSeek-V4).
- ASCII: 4.0 for reasoning streams, 2.9 for answer text, 3.7 for tools and code, 3.3 default for prose.
- Full-width punctuation and full-width characters are counted as 1.

## Local Build

Run `npm run build`, then copy the artifacts to `~/.config/opencode/plugins`.

```powershell
npm run build; $dst = "~\.config\opencode\plugins\opencode-visual-cache"; New-Item -ItemType Directory -Force "$dst\dist" | Out-Null; Copy-Item tui.js "$dst\tui.js" -Force; Copy-Item dist\tui.js "$dst\dist\tui.js" -Force; Copy-Item dist\v2.js "$dst\dist\v2.js" -Force
```

Edit `~/.config/opencode/package.json` and add the dependency.

```jsonc
{
    "type": "module",
    "dependencies": {
        // ...
        "@opentui/solid": "^0.5.1"
    }
}
```

V1 additionally requires editing `~/.config/opencode/tui.json` to add the local TUI plugin.

```jsonc
{
    "$schema": "https://opencode.ai/tui.json",
    "plugin": [
        // ...
        "./plugins/opencode-visual-cache/dist/tui.js"
    ]
}
```

V1 requires restarting opencode; V2 reloads automatically.

## License

MIT
