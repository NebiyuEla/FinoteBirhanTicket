# FinoteBirhan v1.3.8

- Simple admin dashboard with separate confirmed cash, unreconciled cash, not-received cash, and sold-ticket ledger.
- Runtime accounting balance check: confirmed + unreconciled + not received must equal sold ledger.
- Reserved and sold numbers are hidden from Mini App inventory.
- Fresh 5-minute availability snapshots are generated for each Buy/Sell request.
- Mini App sessions are consumed only after successful atomic reservation, preventing false expiry after a stale-number race.
