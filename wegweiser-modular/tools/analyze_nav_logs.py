#!/usr/bin/env python3
"""Analyze Wegweiser v13 navigation-log JSON exports (produced by js/logger.js).

Pure standard library, no third-party dependencies, no npm, no build step.

Usage:
    python3 analyze_nav_logs.py <file-or-dir> [<file-or-dir> ...] [--out DIR]

Each argument may be:
  - a single .json log export file
  - a directory (searched recursively for *.json files)

Produces, in --out (default: current directory):
  - summary.txt
  - route_runs.csv
  - segment_summaries.csv
  - segment_statistics.csv

This script only reads log exports and writes analysis output files. It never
modifies wegweiser-modular/index.html or any other application file.
"""

import argparse
import csv
import glob
import json
import os
import statistics
import sys
from collections import defaultdict


def find_json_files(paths):
    """Expand a mix of files/directories into a sorted, de-duplicated file list."""
    files = []
    for p in paths:
        if os.path.isdir(p):
            files.extend(glob.glob(os.path.join(p, "**", "*.json"), recursive=True))
        elif os.path.isfile(p):
            files.append(p)
        else:
            print("WARNUNG: Pfad nicht gefunden, wird uebersprungen: %s" % p, file=sys.stderr)
    seen = set()
    unique = []
    for f in files:
        rp = os.path.abspath(f)
        if rp not in seen:
            seen.add(rp)
            unique.append(f)
    return sorted(unique)


def load_log_file(path):
    """Load one export; return None (with a warning) on any malformed file
    instead of aborting the whole run."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        print("WARNUNG: Datei konnte nicht gelesen werden, wird uebersprungen: %s (%s)" % (path, e),
              file=sys.stderr)
        return None
    if not isinstance(data, dict) or "events" not in data:
        print("WARNUNG: unerwartetes Format (kein 'events'-Feld), wird uebersprungen: %s" % path,
              file=sys.stderr)
        return None
    return data


def mean_or_none(values):
    vals = [v for v in values if v is not None]
    return round(statistics.mean(vals), 2) if vals else None


def median_or_none(values):
    vals = [v for v in values if v is not None]
    return round(statistics.median(vals), 2) if vals else None


def min_or_none(values):
    vals = [v for v in values if v is not None]
    return min(vals) if vals else None


def max_or_none(values):
    vals = [v for v in values if v is not None]
    return max(vals) if vals else None


def analyze(files):
    """Read every log file's events and build the aggregated views used for
    all four output artifacts."""
    route_starts = {}     # routeRunId -> event dict
    route_ends = {}        # routeRunId -> event dict (ROUTE_END or ROUTE_CANCELLED)
    segment_summaries = [] # list of enriched segment-summary rows
    lost_count_total = 0
    reacquired_count_total = 0
    source_by_route = {}   # routeRunId -> source filename (for traceability)

    for path in files:
        doc = load_log_file(path)
        if doc is None:
            continue
        test_name_meta = (doc.get("metadata") or {}).get("testName", "")
        events = doc.get("events") or []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            name = ev.get("event")
            data = ev.get("data") or {}
            rid = data.get("routeRunId")

            if name == "ROUTE_START":
                route_starts[rid] = {
                    "routeRunId": rid,
                    "testName": data.get("testName", test_name_meta),
                    "destinationId": data.get("destinationId"),
                    "destination": data.get("destination"),
                    "startedAt": ev.get("t"),
                    "sourceFile": os.path.basename(path),
                }
                source_by_route[rid] = os.path.basename(path)
            elif name in ("ROUTE_END", "ROUTE_CANCELLED"):
                route_ends[rid] = {
                    "endedAt": ev.get("t"),
                    "endReason": "arrived" if name == "ROUTE_END" else "cancelled",
                }
            elif name == "SEGMENT_SUMMARY":
                row = dict(data)
                row["routeRunId"] = rid
                row["sourceFile"] = os.path.basename(path)
                segment_summaries.append(row)
            elif name == "LOST_STOPPED":
                lost_count_total += 1
            elif name == "REACQUIRED":
                reacquired_count_total += 1

    # ---- route_runs ----
    all_route_ids = set(route_starts.keys()) | set(route_ends.keys())
    segments_per_route = defaultdict(int)
    for s in segment_summaries:
        segments_per_route[s.get("routeRunId")] += 1

    route_runs = []
    for rid in sorted(all_route_ids, key=lambda x: (x is None, x)):
        start = route_starts.get(rid, {})
        end = route_ends.get(rid, {})
        started_at = start.get("startedAt")
        ended_at = end.get("endedAt")
        duration_ms = (ended_at - started_at) if (started_at is not None and ended_at is not None) else None
        route_runs.append({
            "routeRunId": rid,
            "testName": start.get("testName", ""),
            "destinationId": start.get("destinationId"),
            "destination": start.get("destination"),
            "startedAt": started_at,
            "endedAt": ended_at,
            "durationMs": duration_ms,
            "endReason": end.get("endReason", "unknown"),
            "segmentCount": segments_per_route.get(rid, 0),
            "sourceFile": start.get("sourceFile", source_by_route.get(rid, "")),
        })

    # ---- segment_statistics: grouped by fromTag->toTag ----
    grouped = defaultdict(list)
    for s in segment_summaries:
        key = (s.get("fromTag"), s.get("toTag"))
        grouped[key].append(s)

    segment_statistics = []
    for (from_tag, to_tag), rows in sorted(grouped.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1]))):
        total = len(rows)
        dist_threshold = sum(1 for r in rows if r.get("reason") == "distance-threshold")
        near_loss = sum(1 for r in rows if r.get("reason") == "near-loss-fallback")
        durations = [r.get("trackingDurationMs") for r in rows]
        lost_ms = [r.get("lostTotalMs") for r in rows]
        lost_counts = [r.get("lostCount") for r in rows]
        reacquire_counts = [r.get("reacquireCount") for r in rows]
        min_dists = [r.get("minSegDist") for r in rows]
        segment_statistics.append({
            "fromTag": from_tag,
            "toTag": to_tag,
            "count": total,
            "distanceThresholdCount": dist_threshold,
            "nearLossFallbackCount": near_loss,
            "nearLossFallbackPct": round(100.0 * near_loss / total, 1) if total else None,
            "trackingDurationMsMean": mean_or_none(durations),
            "trackingDurationMsMedian": median_or_none(durations),
            "trackingDurationMsMin": min_or_none(durations),
            "trackingDurationMsMax": max_or_none(durations),
            "lostTotalMsMean": mean_or_none(lost_ms),
            "lostCountMean": mean_or_none(lost_counts),
            "reacquireCountMean": mean_or_none(reacquire_counts),
            "minSegDistMean": mean_or_none(min_dists),
        })

    seg_total = len(segment_summaries)
    dist_threshold_total = sum(1 for s in segment_summaries if s.get("reason") == "distance-threshold")
    near_loss_total = sum(1 for s in segment_summaries if s.get("reason") == "near-loss-fallback")
    fallback_pct = round(100.0 * near_loss_total / seg_total, 1) if seg_total else 0.0

    summary_counts = {
        "routeCount": len(route_runs),
        "segmentCount": seg_total,
        "distanceThresholdCount": dist_threshold_total,
        "nearLossFallbackCount": near_loss_total,
        "nearLossFallbackPct": fallback_pct,
        "lostMarkerCount": lost_count_total,
        "reacquiredCount": reacquired_count_total,
    }

    return route_runs, segment_summaries, segment_statistics, summary_counts


def write_csv(path, rows, fieldnames):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})


def write_summary(path, files, summary_counts):
    lines = []
    lines.append("Wegweiser v13 - Navigations-Log-Analyse")
    lines.append("=" * 44)
    lines.append("Analysierte Dateien: %d" % len(files))
    for f in files:
        lines.append("  - %s" % f)
    lines.append("")
    lines.append("Anzahl Routen:                 %d" % summary_counts["routeCount"])
    lines.append("Anzahl Abschnitte:             %d" % summary_counts["segmentCount"])
    lines.append("distance-threshold-Ankuenfte:  %d" % summary_counts["distanceThresholdCount"])
    lines.append("near-loss-fallback-Ankuenfte:  %d" % summary_counts["nearLossFallbackCount"])
    lines.append("near-loss-fallback-Anteil:     %.1f %%" % summary_counts["nearLossFallbackPct"])
    lines.append("Markierung verloren (Anzahl):  %d" % summary_counts["lostMarkerCount"])
    lines.append("Markierung wiedergefunden:     %d" % summary_counts["reacquiredCount"])
    lines.append("")
    text = "\n".join(lines) + "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+",
                         help="ein oder mehrere JSON-Dateien und/oder Verzeichnisse")
    parser.add_argument("--out", default=".",
                         help="Zielverzeichnis fuer summary.txt/*.csv (Default: aktuelles Verzeichnis)")
    args = parser.parse_args()

    files = find_json_files(args.paths)
    if not files:
        print("Keine JSON-Dateien gefunden.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.out, exist_ok=True)

    route_runs, segment_summaries, segment_statistics, summary_counts = analyze(files)

    write_csv(os.path.join(args.out, "route_runs.csv"), route_runs, [
        "routeRunId", "testName", "destinationId", "destination",
        "startedAt", "endedAt", "durationMs", "endReason", "segmentCount", "sourceFile"
    ])
    write_csv(os.path.join(args.out, "segment_summaries.csv"), segment_summaries, [
        "routeRunId", "segIndex", "fromTag", "toTag", "reason", "edgeDistanceM",
        "lastRawDist", "lastEma", "minSegDist", "trackingDurationMs", "detectionCount",
        "lostCount", "reacquireCount", "lostTotalMs", "awayWarned", "sourceFile"
    ])
    write_csv(os.path.join(args.out, "segment_statistics.csv"), segment_statistics, [
        "fromTag", "toTag", "count", "distanceThresholdCount", "nearLossFallbackCount",
        "nearLossFallbackPct", "trackingDurationMsMean", "trackingDurationMsMedian",
        "trackingDurationMsMin", "trackingDurationMsMax", "lostTotalMsMean",
        "lostCountMean", "reacquireCountMean", "minSegDistMean"
    ])
    summary_text = write_summary(os.path.join(args.out, "summary.txt"), files, summary_counts)

    print(summary_text, end="")


if __name__ == "__main__":
    main()
