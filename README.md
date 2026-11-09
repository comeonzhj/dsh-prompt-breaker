# Prompt Breaker · 提示词打砖块

A tiny arcade for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
every human prompt is laid out as a character-per-brick wall. Each Agent tool
call fires one random shot and knocks out one character.

This is a DSH Web plugin — it renders in the conversation UI as a draggable
floating cabinet and reads the live Session event stream; the Host keeps no
game state.

```
YOU: "Refactor the auth module and add tests"
        ↓ characters become bricks
AGENT: read → bash → edit → bash → write
        ↓ one bullet per tool call
        ▽  one random visible brick explodes each time
```

## Install

### From the DSH Web UI / agent

Install this GitHub repository as a profile bundle. The archive URL is the
most firewall-friendly form and is the one verified for this release:

```text
https://github.com/comeonzhj/dsh-prompt-breaker/archive/refs/tags/v1.1.0.tar.gz
```

In the Plugins page, use the add/install action with that spec. An agent with
the `plugin_manager` tool can do the same:

```json
{
  "action": "install_bundle",
  "target": "https://github.com/comeonzhj/dsh-prompt-breaker/archive/refs/tags/v1.1.0.tar.gz"
}
```

DSH also accepts a Git repository address (`github:comeonzhj/dsh-prompt-breaker`
or `https://github.com/comeonzhj/dsh-prompt-breaker`). DSH probes GitHub for up
to 5 seconds before a Git install; on a slow link, use the archive URL above
instead.

### From the CLI

On a profile that is not managed exclusively by the Desktop app:

```bash
dsh plugin --profile <profile> add https://github.com/comeonzhj/dsh-prompt-breaker/archive/refs/tags/v1.1.0.tar.gz
```

Refresh the DSH Web page after installation so the new Client module is loaded.

## How it plays

- **Live wall** — the newest prompt is restored when the card mounts; later
  prompts append with a fresh color family.
- **One call, one bullet** — durable `tool/call` Session events drive shots.
  The brick is removed when the bullet arrives.
- **Line of sight** — only bricks with an unobstructed straight line from the
  barrel are targets. Bullets cannot tunnel through a lower row into the
  middle of the wall.
- **Visible launch** — the wall sits above the cannon with an open gap, and
  shots render from the barrel tip across that gap into the wall.
- **Task aware** — a completed `turn/end` holds fire while bricks remain. A
  new prompt resumes the game.
- **Early clear** — if the wall is demolished before the task ends, a confetti
  celebration takes over.
- **Adaptive** — columns, cell size, gap, and font are recalculated from the
  actual board box; a 900-brick cap avoids overflow and reports dropped
  characters.
- **Floating cabinet** — drag by the header, minimize with the dash. Position
  and minimized state persist in `localStorage`.

## Files

```text
package.json        bundle + client manifest
cordis.patch.yml    one profile row
index.js            inert Host half
client.js           slot entry, event fold, renderer and CSS
locale/{zh,en}.json Plugin Manager display metadata
icon.svg            original cabinet icon
```

## License

MIT. See [LICENSE](LICENSE).
