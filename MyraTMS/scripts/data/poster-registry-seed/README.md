# Poster registry seed data

Place normalized CSV files here before running `scripts/e2_seed_poster_registry.ts`.
Each file needs this header row exactly:

```
legal_name,mc_number,dot_number,country,province_state
```

`mc_number`/`dot_number` may be blank (common for Canadian domestic-only
shippers — see PRD §0.3.1). `country` is `CA` or `US`. `province_state` is
optional, used only as a human-readable note.

| File | Source (per E2-01 §4.4) | entity_class | class_source | confidence |
|---|---|---|---|---|
| `pilot1-shippers.csv` | Pilot 1 Ontario shipper lead list (205 rows) | `shipper` | `seed_shipper_list` | 0.9 |
| `ontario-mines.csv` | Ontario mines dossier (~40 rows) | `shipper` | `seed_mines_dossier` | 0.95 |
| `broker-list.csv` | Known-broker list (~60 rows, Appendix B) | `broker` | `seed_broker_list` | 0.9 |

Not yet supplied as of E2-01 M1 Session 1 (2026-08-24) — convert
`Ontario_Carrier_Network_Directory_1.xlsx` and `Ontario_Mines_Intelligence_Report.docx`
to this format when available. The script skips any missing file with a
warning rather than failing, so it's safe to run with only a subset present.
