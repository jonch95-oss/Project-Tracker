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

/** Options for a photo just taken with the camera: stamped, and located when the person turned that on. */
export async function cameraOptions(): Promise<{
  camera: true;
  location: PhotoLocation | null;
}> {
  return {
    camera: true,
    location: locationOn() ? await currentLocation() : null,
  };
}
