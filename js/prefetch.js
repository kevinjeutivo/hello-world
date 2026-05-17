Three files, SW v51.
The approach — cadence extrapolation + gap refinement:

Anchor: Start from snap.earningsDate — the confirmed next earnings date already fetched from Finnhub's forward calendar
Step back: Subtract 91 days (one quarter) eight times to generate 8 estimated historical earnings dates
Refine each estimate: Within a ±10 trading day window around each estimate, find the largest overnight price gap ≥3%. If found, snap the date to the actual gap date — this is the real announcement date. If not found, keep the closest trading day to the estimate
Classify: source:'gap-confirmed' when a real gap was found, source:'estimated' when using the cadence estimate only

Visual distinction on the chart:

Solid amber line = gap-confirmed (high confidence — price actually moved ≥3% near this date)
Dashed amber line = estimated (cadence-derived, no confirming gap found — lower confidence)

The legend updates to explain this distinction. The ±10 trading day search window (~2 calendar weeks) accommodates companies that don't report on exactly 91-day intervals, early/late reporters, and holiday shifts.
  
