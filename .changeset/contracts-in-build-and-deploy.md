---
"playground-cli": minor
---

`dot build` and `dot deploy` now handle ink! contracts via `@dotdm/contracts`.

- `dot build`: new TUI — compiles contracts and the frontend in parallel, with a unified log tail.
- `dot deploy`: contracts build + deploy + publish runs before the frontend build, then `cdm i` refreshes `cdm.json` with fresh on-chain addresses before the frontend uses them. Contract signatures batch per layer (two phone taps per layer: one deploy+register on AssetHub, one publish on Bulletin). Projects with no contracts detected skip the phase silently.
