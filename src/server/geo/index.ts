import "server-only";

/**
 * Address → coordinates (and BBL when known) for the portfolio map.
 * Production uses NYC Planning Labs GeoSearch: public, free, no key, built on
 * the city's own address data (PAD). Tests use a stub. A failed lookup never
 * blocks saving a project; it just leaves the pin off the map.
 */
export interface GeocodeResult {
  latitude: number;
  longitude: number;
  bbl: string | null;
  label: string;
}

export interface Geocoder {
  readonly name: string;
  geocode(address: string, borough: string): Promise<GeocodeResult | null>;
}

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";

export const geosearchGeocoder: Geocoder = {
  name: "nyc-geosearch",
  async geocode(address, borough) {
    const url = `${GEOSEARCH}?size=1&text=${encodeURIComponent(`${address}, ${borough}, NY`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      features?: { geometry?: { coordinates?: [number, number] }; properties?: { label?: string; borough?: string; addendum?: { pad?: { bbl?: string } } } }[];
    };
    const f = body.features?.[0];
    const c = f?.geometry?.coordinates;
    if (!f || !c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    // A match in another borough is a different building.
    if (f.properties?.borough && f.properties.borough.toLowerCase() !== borough.toLowerCase()) return null;
    const bbl = f.properties?.addendum?.pad?.bbl ?? null;
    return { longitude: c[0], latitude: c[1], bbl: bbl && /^[1-5]\d{9}$/.test(bbl) ? bbl : null, label: f.properties?.label ?? address };
  },
};

let override: Geocoder | null = null;
export function setGeocoderForTests(g: Geocoder | null) {
  override = g;
}

const offGeocoder: Geocoder = { name: "off", geocode: async () => null };

/** GEOCODER=off (end-to-end tests, offline development) skips the lookup. */
export function geocoder(): Geocoder {
  if (override) return override;
  return process.env.GEOCODER === "off" ? offGeocoder : geosearchGeocoder;
}

/** Best-effort lookup: never throws. */
export async function tryGeocode(address: string, borough: string): Promise<GeocodeResult | null> {
  try {
    return await geocoder().geocode(address, borough);
  } catch {
    return null;
  }
}
