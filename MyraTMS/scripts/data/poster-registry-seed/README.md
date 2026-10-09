# Poster registry seed data

Normalized CSV files read by `scripts/e2_seed_poster_registry.ts`. The script
takes **no CSV argument** — it reads the fixed file names below and skips any
missing file with a warning, so it is safe to run with only a subset present.

Generate these from the operator's raw lists with
`scripts/e2_convert_poster_registry_sources.ts` rather than by hand; that script
also writes `MANIFEST.json`, which is what PRD §4.13 criterion 5 ("seed counts
match the manifest") is reconciled against.

Each file needs this header row exactly:

```
legal_name,mc_number,dot_number,country,province_state
```

`mc_number`/`dot_number` may be blank (common for Canadian domestic-only
shippers — see PRD §0.3.1) and must be **digits only** when present; the
converter runs them through `normalizeIdNumber()` so they match the
`poster_mc_number` ingest writes. `country` is `CA` or `US`. `province_state` is
optional, used only as a human-readable note.

## Files, in the order the seed script reads them

The order is fail-closed — broker lists first, the accepting `shipper` class
last — so that a company present in two lists is already in `poster_registry`
as `broker` by the time a lower-precedence source is read, and `seedFromCsv`'s
"never downgrade an equal-or-higher-confidence row" guard keeps it there.

| # | File | Source | entity_class | class_source | confidence | Rows (2026-10-09) |
|---|---|---|---|---|---|---|
| 1 | `broker-list-fmcsa.csv` | FMCSA Canadian broker registry, legal names + distinct DBAs | `broker` | `seed_broker_list_fmcsa` | 0.95 | 1524 |
| 2 | `broker-list.csv` | Known-broker list (Appendix B) | `broker` | `seed_broker_list` | 0.9 | 52 |
| 3 | `carriers-for-hire.csv` | Ontario + Canadian trucking directories | `carrier_for_hire` | `seed_carrier_list` | 0.9 | 381 |
| 4 | `ontario-mines.csv` | Ontario mining lead list | `shipper` | `seed_mines_dossier` | 0.95 | 48 |
| 5 | `pilot1-shippers.csv` | Pilot 1 Ontario shipper lead list (~205 rows) | `shipper` | `seed_shipper_list` | 0.9 | **absent** |

## Why trucking companies are `carrier_for_hire`, not `shipper`

A trucking company is not a shipper. `carrier_for_hire` routes a poster to
`carrier_reposted` → human review; `shipper` routes it to `shipper_direct` →
**accept**. Seeding a carrier directory as `shipper` would manufacture exactly
the false accepts the shipper-direct gate exists to prevent. 68 companies in
these lists appear in *both* a trucking directory and a broker list (Bison
Transport, Charger Logistics, CSA Transportation, …) — the same pattern the live
FMCSA runs found on 2026-10-08, where carriers and even shippers routinely hold
broker authority as well. All 1,264 FMCSA rows carry active Property Broker
authority, so for those 68 the broker label is authoritative and the converter
drops them from `carriers-for-hire.csv`. `MANIFEST.json.precedenceOverrides`
lists every one.

## Only 48 accepts are currently reachable

`ontario-mines.csv` is the only `shipper`-class file present, so exactly 48
posters can produce a `shipper_direct` accept from the registry. Until
`pilot1-shippers.csv` lands, every other poster resolves to reject (broker),
review (carrier), or review (registry miss). Since FMCSA cannot establish
shipper-direct status, there is no second accept path — see the tracker entries
dated 2026-10-08 and 2026-10-09.
