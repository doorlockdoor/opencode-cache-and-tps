## Introduction

Forked from opencode-visual-cache, adding first-token latency (TTFT), generation speed (TPS), and more, with real-time refresh.
> ✅ Updated for opencode v2 compatibility.

<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_01.png" width="100%"></img>

**Display style settings**:
- `/cache-bar` — configure which items the bottom bar shows; by default only "Hit rate" and "Speed" are shown.
- `/cache-live-style` — set the style of the real-time TPS and other live info: Default, DSH, or Minimal.
- `/cache-bar-style` — set the style of the exact TPS and other stats: Default or Minimal.

**Included metrics**:
- **TTFT**: Time to first token — perceived time from when the user sends a request (step) to when the first token arrives.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: Model generation time per request (step) — perceived time, excluding tool-call time.
- Errors introduced by OpenCode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).

**Real-time TPS estimation**:
- While streaming, the token count is an estimate that varies slightly by model; it is replaced with the exact value once the stream ends.
- Chinese characters: 1.5 chars/token (measured 1.34 on GPT-o200k, 1.52 on DeepSeek-V4).
- ASCII: 4.0 for reasoning streams, 2.9 for answer text, 3.7 for tools & code, 3.3 default for prose.
- Full-width punctuation and full-width characters are counted as 1.

## Local Build

Clone the repository and run the following command. It builds automatically, copies the artifacts to `~/.config/opencode/plugins`, and sets up the config file and dependencies.

```bash
node install.mjs
```

## License

MIT
