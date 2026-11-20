"""Step 1 checks (acceptance check A1 plus sanity checks). Exit code 1 if any fail."""
import csv
import json
import sys

from common import OUT

TOL = 0.01  # within 1%


def near(a, b):
    return abs(a - b) <= TOL * b


def main():
    t = json.loads((OUT / "step1_totals.json").read_text())
    r = json.loads((OUT / "roads_summary.json").read_text())
    with open(OUT / "hexes.csv", newline="") as f:
        hexes = list(csv.DictReader(f))
    with open(OUT / "work_flows.csv", newline="") as f:
        flow_total = sum(int(row["workers"]) for row in csv.DictReader(f))

    checks = [
        ("A1 people in hexes = Census 2020 (1,290,188)",
         near(sum(int(h["people"]) for h in hexes), t["people"]["census_published"])),
        ("A1 jobs in hexes = LODES 2022 county total",
         near(sum(int(h["jobs"]) for h in hexes), t["jobs"]["lodes_county"])),
        ("A1 cars in hexes = ACS county total",
         near(sum(float(h["cars_acs"]) for h in hexes), t["cars"]["acs_county"])),
        ("A1 scaled cars = Texas DMV ~1.0 million",
         near(sum(float(h["cars"]) for h in hexes), t["cars"]["registered_target"])),
        ("hex count close to spec (~3,600; 2,800-4,000)", 2800 <= len(hexes) <= 4000),
        ("work flow file matches totals", flow_total == t["work_flows"]["workers_in_county"]),
        ("roads: one connected network keeps > 95% of junctions",
         r["junctions_kept"] > 0.95 * r["junctions_total"]),
        ("roads: has motorways, residential streets", r["road_miles"]["motorway"] > 50
         and r["road_miles"]["residential"] > 1000),
    ]
    ok = True
    for name, passed in checks:
        print(("PASS " if passed else "FAIL ") + name)
        ok &= passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
