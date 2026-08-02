// pattern: Imperative Shell

export type ReadsbAircraft = {
  hex: string;
  type?: string;
  flight?: string;
  alt_baro?: number | string;
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
  nav_qnh?: number;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  seen: number;
  rssi: number;
  messages: number;
  lastPosition?: {
    lat: number;
    lon: number;
    nic: number;
    rc: number;
    seen_pos: number;
  };
};

export type ReadsbData = {
  now: number;
  messages: number;
  aircraft: Array<ReadsbAircraft>;
};

export type ReadsbStats = {
  now: number;
  gain_db: number;
  aircraft_with_pos: number;
  aircraft_without_pos: number;
  last1min: {
    start: number;
    end: number;
    local: {
      signal: number;
      noise: number;
      peak_signal: number;
      strong_signals: number;
    };
    messages_valid: number;
    position_count_total: number;
  };
};

export async function fetchAircraft(baseUrl: string): Promise<ReadsbData> {
  const res = await fetch(`${baseUrl}/data/aircraft.json`);
  if (!res.ok) throw new Error(`readsb aircraft.json: ${res.status}`);
  return res.json() as Promise<ReadsbData>;
}

export async function fetchStats(baseUrl: string): Promise<ReadsbStats> {
  const res = await fetch(`${baseUrl}/data/stats.json`);
  if (!res.ok) throw new Error(`readsb stats.json: ${res.status}`);
  return res.json() as Promise<ReadsbStats>;
}
