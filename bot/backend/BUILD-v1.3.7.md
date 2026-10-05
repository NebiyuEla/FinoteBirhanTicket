# FinoteBirhan v1.3.7 revenue reconciliation and reservation safety

- Dashboard `Confirmed money received` counts only receipts explicitly verified by Verify.et or an administrator.
- Historical SOLD rows are `unreconciled` by default and are not assumed to be cash received.
- Admin `Reconcile Revenue` lets verified historical receipts be marked Received or Not received without deleting tickets.
- Sold ticket value remains a separate operational figure and Bundle remains 300 ETB.
- Unpaid reservations have a minimum 60-minute window.
- Once payment proof is submitted or a seller taps Buyer paid, the ticket number no longer auto-expires while awaiting admin review.
- Stale reserved locks for expired/rejected/cancelled purchases are released; paid reservations are repaired to SOLD rather than released.
