// Loads the World in the browser (inside the simulation worker).
import { fetchGzipBytes, fetchText } from '../data';
import { World } from './world';

export async function loadWorld(base: string): Promise<World> {
  const t = (f: string) => fetchText(`${base}data/${f}`);
  const b = (f: string) => fetchGzipBytes(`${base}data/${f}`);
  const [hexesCsv, flowsCsv, vehicleCsv, demandCsv, hourlyCsv, shareCsv, slowdownCsv, areaCsv, hubsCsv, hubSitesCsv,
    base16, slow16, next8, neigh16] = await Promise.all([
    t('hexes.csv'), t('work_flows.csv'), t('vehicle.csv'), t('demand.csv'), t('hourly.csv'), t('share.csv'),
    t('slowdown.csv'), t('area.csv'), t('hubs.csv'), t('hub_sites.csv'),
    b('tt_base.bin.gz'), b('tt_slow.bin.gz'), b('next_hop.bin.gz'), b('hex_neighbours.bin.gz'),
  ]);
  return new World({
    hexesCsv, flowsCsv, vehicleCsv, demandCsv, hourlyCsv, shareCsv, slowdownCsv, areaCsv, hubsCsv, hubSitesCsv,
    base: new Uint16Array(base16), slow: new Uint16Array(slow16),
    nextHop: new Uint8Array(next8), neighbours: new Uint16Array(neigh16),
  });
}
