# png-squeeze-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Jalen-lab/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Jalen-lab/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG screenshot compressor: it reads each 1280×720 RGBA screenshot from the input directory and writes the smallest equivalent PNG it can find. It tries palette forms (frequency- and luminance-ordered) and channel forms (grey / RGB / grey+alpha / RGBA, with a transparent-colour key when one exists), screens eight filter strategies per form with real zlib sizes, and finishes the winner with zlib level 9 into a single IDAT chunk. Fully deterministic — same input, byte-identical output — and it needs no network and no dependencies beyond Node's built-ins.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/image.png` and writes `/output/<id>/image.png` (override with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`). On the practice set it scores about 701,000 / 1,000,000, answering all 8 images in roughly 13 seconds.

---

<sub>Entered on [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
