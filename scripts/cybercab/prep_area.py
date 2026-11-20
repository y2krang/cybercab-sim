"""Step 1a: Travis County hexes with people, jobs, workers and cars.

Inputs (in DOWNLOADS):
  tl_2020_48_tabblock20.zip      Census 2020 Texas blocks with POP20, HOUSING20
  tx_wac_S000_JT00_2022.csv.gz   LODES 2022 jobs by workplace block
  tx_rac_S000_JT00_2022.csv.gz   LODES 2022 workers by home block
  tx_od_main_JT00_2022.csv.gz    LODES 2022 home-to-work flows
  acsdt5y2024-b25044.dat         ACS 2020-2024 vehicles available, by tract

Outputs (in apps/cybercab/public/data):
  hexes.csv, work_flows.csv, county.geojson, step1_totals.json
"""
import json
import sys

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
from shapely.geometry import mapping

from common import COUNTY_FIPS, DOWNLOADS, H3_RES, OUT, WORK, ensure_dirs, param, read_params


def load_blocks():
    b = gpd.read_file(f"zip://{DOWNLOADS / 'tl_2020_48_tabblock20.zip'}", engine="pyogrio",
                      where=f"COUNTYFP20 = '{COUNTY_FIPS[2:]}'")
    b = b[b["GEOID20"].str.startswith(COUNTY_FIPS)].copy()
    b["POP20"] = b["POP20"].astype(int)
    b["HOUSING20"] = b["HOUSING20"].astype(int)
    b["lat"] = b["INTPTLAT20"].astype(float)
    b["lng"] = b["INTPTLON20"].astype(float)
    b["hex"] = [h3.latlng_to_cell(la, lo, H3_RES) for la, lo in zip(b["lat"], b["lng"])]
    b["tract"] = b["GEOID20"].str[:11]
    return b


def load_lodes(name, geo_col):
    df = pd.read_csv(DOWNLOADS / name, usecols=[geo_col, "C000"], dtype={geo_col: str})
    return df[df[geo_col].str.startswith(COUNTY_FIPS)]


def tract_vehicles(five_plus):
    df = pd.read_csv(DOWNLOADS / "acsdt5y2024-b25044.dat", sep="|", dtype={"GEO_ID": str})
    df = df[df["GEO_ID"].str.startswith("1400000US" + COUNTY_FIPS)].copy()
    df["tract"] = df["GEO_ID"].str[9:]
    # E003-E008 owner households with 0,1,2,3,4,5+ vehicles; E010-E015 renters.
    weights = [0, 1, 2, 3, 4, five_plus]
    veh = 0
    for i, w in enumerate(weights):
        veh = veh + w * (df[f"B25044_E{3 + i:03d}"].astype(float) + df[f"B25044_E{10 + i:03d}"].astype(float))
    df["vehicles"] = veh
    df["households_acs"] = df["B25044_E001"].astype(float)
    return df[["tract", "vehicles", "households_acs"]]


def main():
    ensure_dirs()
    area = read_params("area.csv")
    blocks = load_blocks()
    print(f"blocks: {len(blocks):,}  people: {blocks['POP20'].sum():,}")

    # County outline from the blocks, and every hex that touches it.
    county = blocks.geometry.union_all()
    gpd.GeoSeries([county], crs=blocks.crs).to_file(WORK / "county.gpkg", driver="GPKG")
    hexes = set(h3.geo_to_cells(mapping(county), H3_RES)) | set(blocks["hex"])

    # Cars: tract vehicles spread to blocks by housing units.
    tv = tract_vehicles(param(area, "vehicles_for_5plus_households"))
    tract_housing = blocks.groupby("tract")["HOUSING20"].sum().rename("tract_housing")
    blocks = blocks.join(tract_housing, on="tract").merge(tv, on="tract", how="left")
    missing = blocks.loc[blocks["vehicles"].isna(), "tract"].unique()
    if len(missing):
        print(f"WARNING: {len(missing)} block tracts not in ACS: {list(missing)[:5]}")
    blocks["vehicles"] = blocks["vehicles"].fillna(0)
    no_housing = (blocks["tract_housing"] == 0) & (blocks["vehicles"] > 0)
    if no_housing.any():
        print(f"WARNING: {no_housing.sum()} blocks in tracts with cars but no housing")
    blocks["cars_acs"] = np.where(blocks["tract_housing"] > 0,
                                  blocks["vehicles"] * blocks["HOUSING20"] / blocks["tract_housing"].replace(0, 1), 0)
    acs_total = tv["vehicles"].sum()

    # Jobs and workers by block.
    wac = load_lodes("tx_wac_S000_JT00_2022.csv.gz", "w_geocode")
    rac = load_lodes("tx_rac_S000_JT00_2022.csv.gz", "h_geocode")
    block_hex = dict(zip(blocks["GEOID20"], blocks["hex"]))
    wac["hex"] = wac["w_geocode"].map(block_hex)
    rac["hex"] = rac["h_geocode"].map(block_hex)
    for name, df in (("wac", wac), ("rac", rac)):
        lost = df["hex"].isna().sum()
        if lost:
            print(f"WARNING: {lost} {name} blocks not found in census blocks")

    per_hex = pd.DataFrame(index=sorted(hexes))
    per_hex["people"] = blocks.groupby("hex")["POP20"].sum()
    per_hex["households"] = blocks.groupby("hex")["HOUSING20"].sum()
    per_hex["jobs"] = wac.groupby("hex")["C000"].sum()
    per_hex["workers"] = rac.groupby("hex")["C000"].sum()
    per_hex["cars_acs"] = blocks.groupby("hex")["cars_acs"].sum()
    per_hex = per_hex.fillna(0)
    scale = param(area, "registered_vehicles") / per_hex["cars_acs"].sum()
    per_hex["cars"] = per_hex["cars_acs"] * scale
    ll = [h3.cell_to_latlng(h) for h in per_hex.index]
    per_hex.insert(0, "lat", [round(a, 6) for a, _ in ll])
    per_hex.insert(1, "lng", [round(b, 6) for _, b in ll])
    for c in ("people", "households", "jobs", "workers"):
        per_hex[c] = per_hex[c].astype(int)
    per_hex["cars_acs"] = per_hex["cars_acs"].round(1)
    per_hex["cars"] = per_hex["cars"].round(1)
    per_hex.index.name = "h3"
    per_hex.to_csv(OUT / "hexes.csv")

    # Home-to-work flows inside the county, by hex pair.
    od = pd.read_csv(DOWNLOADS / "tx_od_main_JT00_2022.csv.gz", usecols=["w_geocode", "h_geocode", "S000"],
                     dtype={"w_geocode": str, "h_geocode": str})
    od_work_in = od[od["w_geocode"].str.startswith(COUNTY_FIPS)]
    od_in = od_work_in[od_work_in["h_geocode"].str.startswith(COUNTY_FIPS)].copy()
    od_in["home"] = od_in["h_geocode"].map(block_hex)
    od_in["work"] = od_in["w_geocode"].map(block_hex)
    flows = od_in.groupby(["home", "work"])["S000"].sum().rename("workers").reset_index()
    flows.to_csv(OUT / "work_flows.csv", index=False)

    # Small outline for the map page.
    simple = gpd.GeoSeries([county], crs=blocks.crs).to_crs(4326).simplify(0.0005)
    (OUT / "county.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": "Travis County"}, "geometry": mapping(simple.iloc[0])}]}))

    totals = {
        "hexes": len(per_hex),
        "people": {"hexes": int(per_hex["people"].sum()), "census_blocks": int(blocks["POP20"].sum()),
                   "census_published": int(param(area, "census_2020_population"))},
        "jobs": {"hexes": int(per_hex["jobs"].sum()), "lodes_county": int(wac["C000"].sum())},
        "workers": {"hexes": int(per_hex["workers"].sum()), "lodes_county": int(rac["C000"].sum())},
        "cars": {"hexes_acs": round(float(per_hex["cars_acs"].sum())), "acs_county": round(float(acs_total)),
                 "hexes_scaled": round(float(per_hex["cars"].sum())),
                 "registered_target": int(param(area, "registered_vehicles"))},
        "work_flows": {"pairs": len(flows), "workers_in_county": int(flows["workers"].sum()),
                       "workers_commuting_in": int(od_work_in["S000"].sum() - od_in["S000"].sum())},
        "county_area_sq_mi": round(float(gpd.GeoSeries([county], crs=blocks.crs).to_crs(5070).area.iloc[0] / 2.59e6), 1),
    }
    (OUT / "step1_totals.json").write_text(json.dumps(totals, indent=2))
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    sys.exit(main())
