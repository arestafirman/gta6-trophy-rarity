# GTA VI trophy rarity forecast — earners over players

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/arestafirman/gta6-trophy-rarity/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/arestafirman/gta6-trophy-rarity/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Entry for [gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) on make.fun: forecast every GTA VI trophy's earn rate on Exophase at 2026-11-26T00:00:00Z.

## Model

A trophy's earn rate is a ratio — `rate = 100 × earners / players_tracked` — and the two counts move on their own clocks, so the program never fits the rate directly. It reconstructs both counts from every history read (`e = round(rate × P / 100)`) and projects each one to the target, then divides.

- **FLAT history** (launch night: every read shows the same frozen page, 638 players): the RULES state Exophase's first refresh outright — 04:30 UTC 19 Nov, 3,868 players, every rate but the 100% one lower. With earners unchanged across a refresh the new rate is pure dilution, `rate' = 100 × e / 3868`, printed to 2 decimals; the 100% prologue trophy stays 100%. All five quantiles equal the diluted rate.
- **RICH history** (the final case): players and per-trophy earners each follow a log-time trend, `ln(count) = a + b·ln(1+h)`, fit by least squares over the last 24 h of reads and projected to the target. Median `rate* = 100 × e* / P*`. The logit spread per trophy is calibrated by backtest: fit on the first 60% of the history's time span, forecast the later reads, take the SD of the logit errors (grown with horizon).
- Trophies nobody has earned yet get a median of 0.005% with a wide spread — they may earn their first trophies by the target. The 100% trophy stays 100%.

## Run

Node 22, standard library only, no network, deterministic (two runs byte-identical):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory, writes `<id>.out` (`{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`) to the output directory.

<sub>Entered on [make.fun](https://make.fun/?ref=j2ays5z3&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
