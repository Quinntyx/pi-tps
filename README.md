# pi-tps

Tokens-per-second meter for [Pi](https://github.com/earendil-works/pi-coding-agent)'s
footer status cluster.

Each assistant turn is measured as output tokens (final `usage`, including
reasoning tokens) divided by the wall-clock time the provider stream was open.
While a turn is streaming, a `~`-prefixed live estimate is shown from
accumulated delta characters (~4 chars/token); it is replaced by the exact
value when the turn ends. Aborted/errored turns are discarded and the last
exact reading is restored.

Display publishes `NN t/s` through the generic **status-item protocol**
(consumed by [pi-opencode-prompt](https://git.quinntyx.dev/quinntyx/pi-opencode-prompt)'s
status row — that extension replaces the built-in footer, so
`ctx.ui.setStatus()` alone is invisible there):

- `status-item` — `{ key, text }` to set or clear an extension's cluster item
- `status-item:request` — emitted on session_start; extensions re-publish

`ctx.ui.setStatus("pi-tps", …)` is also kept for UIs that render the standard
footer. `/tps` shows session stats: last, average, min/max, and overall TPS.

Install as a Pi git package (main profile):

```json
"git:git.quinntyx.dev/quinntyx/pi-tps"
```

or:

```sh
pi install git:git.quinntyx.dev/quinntyx/pi-tps
```
