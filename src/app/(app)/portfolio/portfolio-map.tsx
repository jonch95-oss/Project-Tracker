"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { currentPhase } from "@/core/phases";
import type { PortfolioProject } from "./portfolio-view";

/**
 * Map of every project with a location. Tiles: OpenFreeMap's Positron style
 * (free for commercial use, no key, no request limits; attribution shown by
 * MapLibre). Locations come from the city's address data when a project is
 * saved; projects without one are listed under the map.
 */
const STYLE = "https://tiles.openfreemap.org/styles/positron";
const NYC: [number, number] = [-73.95, 40.68];

export function PortfolioMap({ projects }: { projects: PortfolioProject[] }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const located = projects.filter((p) => p.latitude != null && p.longitude != null);
  const unlocated = projects.filter((p) => p.latitude == null || p.longitude == null);
  const key = located.map((p) => `${p.id}:${p.latitude}:${p.longitude}`).join("|");

  useEffect(() => {
    if (!el.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el.current,
        style: STYLE,
        center: NYC,
        zoom: 11,
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
    } catch {
      // No WebGL (old device or locked-down browser): fall back to the list.
      queueMicrotask(() => setFailed(true));
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // If the style itself can't load (offline, blocked), show the list instead of a blank box.
    map.on("error", () => {
      if (!map.isStyleLoaded()) setFailed(true);
    });
    const markers: maplibregl.Marker[] = [];
    for (const p of located) {
      const pin = document.createElement("a");
      pin.href = `/projects/${p.id}`;
      pin.className = "pc-map-pin";
      pin.setAttribute("aria-label", `${p.name}, ${p.address}`);
      const dot = document.createElement("span");
      dot.className = "pc-map-dot";
      const label = document.createElement("span");
      label.className = "pc-map-label";
      label.textContent = p.name;
      const phase = document.createElement("span");
      phase.className = "pc-map-phase";
      phase.textContent = currentPhase(p.phases)?.name ?? "Complete";
      label.appendChild(phase);
      pin.append(dot, label);
      markers.push(new maplibregl.Marker({ element: pin, anchor: "left" }).setLngLat([p.longitude!, p.latitude!]).addTo(map));
    }
    if (located.length > 1) {
      const b = new maplibregl.LngLatBounds();
      for (const p of located) b.extend([p.longitude!, p.latitude!]);
      map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 40, right: 200 }, maxZoom: 15, duration: 0 });
    } else if (located.length === 1) {
      map.jumpTo({ center: [located[0]!.longitude!, located[0]!.latitude!], zoom: 15 });
    }
    return () => {
      for (const m of markers) m.remove();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-render the map only when the located set changes
  }, [key]);

  return (
    <div className="flex flex-col gap-4">
      {failed ? (
        <Schematic projects={located} />
      ) : (
        <div ref={el} className="h-[560px] overflow-hidden rounded-card border border-border bg-stone max-sm:h-[70vh]" role="region" aria-label="Project map" />
      )}
      {unlocated.length > 0 && (
        <div className="rounded-card border border-border bg-surface px-6 py-4">
          <p className="text-[13px] font-medium">Not on the map yet</p>
          <p className="text-[12px] text-muted">Their address wasn&apos;t found in the city&apos;s address data. Check the address, then save the project again.</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {unlocated.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="inline-flex h-9 items-center rounded-full border border-border px-3 text-[13px] hover:bg-sunken">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Offline / no-WebGL fallback: the projects plotted by their coordinates on a
 * plain stone ground, so relative positions still read without map tiles.
 */
function Schematic({ projects }: { projects: PortfolioProject[] }) {
  const W = 1000;
  const H = 560;
  const pad = 80;
  const lats = projects.map((p) => p.latitude!);
  const lngs = projects.map((p) => p.longitude!);
  const [minLat, maxLat] = [Math.min(...lats, 40.6), Math.max(...lats, 40.75)];
  const [minLng, maxLng] = [Math.min(...lngs, -74.02), Math.max(...lngs, -73.9)];
  // Longitude degrees are shorter than latitude degrees at NYC's latitude.
  const k = Math.cos((40.7 * Math.PI) / 180);
  const spanX = (maxLng - minLng) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const x = (lng: number) => pad + ((lng - minLng) * k) * scale + ((W - pad * 2) - spanX * scale) / 2;
  const y = (lat: number) => H - pad - (lat - minLat) * scale - ((H - pad * 2) - spanY * scale) / 2;
  return (
    <figure className="overflow-hidden rounded-card border border-border bg-stone">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Project locations (schematic)">
        <defs>
          <pattern id="pc-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="currentColor" strokeOpacity="0.08" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#pc-grid)" className="text-text" />
        {projects.map((p) => (
          <a key={p.id} href={`/projects/${p.id}`} aria-label={`${p.name}, ${p.address}`}>
            <circle cx={x(p.longitude!)} cy={y(p.latitude!)} r="8" className="fill-accent stroke-surface" strokeWidth="3" />
            <text x={x(p.longitude!) + 14} y={y(p.latitude!) + 5} className="fill-text text-[15px] font-medium">
              {p.name}
            </text>
          </a>
        ))}
      </svg>
      <figcaption className="border-t border-border bg-surface px-5 py-3 text-[12px] text-muted">
        The street map couldn&apos;t load here (offline, or the browser can&apos;t draw it), so this is a plain plot of where each project sits.
      </figcaption>
    </figure>
  );
}
