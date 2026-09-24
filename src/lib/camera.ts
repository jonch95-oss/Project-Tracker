"use client";

import type { PhotoLocation } from "./photo-upload";

const LOCATION_KEY = "pc.camera.location";

/** Whether this person wants their location added to photos they take (a per-device choice, off by default). */
export function locationOn(): boolean {
  try {
    return localStorage.getItem(LOCATION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLocationOn(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCATION_KEY, "1");
    else localStorage.removeItem(LOCATION_KEY);
  } catch {}
}

/** The device's position, or null (no permission, no fix within a few seconds, or no GPS). Never throws. */
export function currentLocation(
  timeoutMs = 6000,
): Promise<PhotoLocation | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (v: PhotoLocation | null) => resolve(v);
    const timer = setTimeout(() => done(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        done({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracyM: Number.isFinite(p.coords.accuracy)
            ? Math.round(p.coords.accuracy)
            : null,
        });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** A file counts as just taken with the camera only if it was made in the last couple of minutes (not picked from the library). */
const FRESH_MS = 2 * 60 * 1000;

export function freshShot(files: readonly File[], now = Date.now()): boolean {
  return files.length > 0 && files.every((f) => Math.abs(now - f.lastModified) < FRESH_MS);
}

/**
 * Options for photos from a "Take photo" button: stamped with the time and,
 * if the person turned location on, located. A photo picked from the library
 * instead (desktop, or iPhone's library option) keeps its own EXIF time and
 * gets neither.
 */
export async function cameraOptions(files: readonly File[]): Promise<{ camera: boolean; location: PhotoLocation | null }> {
  if (!freshShot(files)) return { camera: false, location: null };
  return { camera: true, location: locationOn() ? await currentLocation() : null };
}
