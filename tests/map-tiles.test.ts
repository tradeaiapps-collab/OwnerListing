import { describe, expect, it } from "vitest";
import { mapTileSource, osmLink, OSM_ATTRIBUTION, OSM_TILE_URL } from "../src/domain/map-tiles";

describe("map tile source", () => {
  it("defaults to OpenStreetMap with its attribution", () => {
    for (const s of [mapTileSource(), mapTileSource("openstreetmap"), mapTileSource("OpenStreetMap", "")]) {
      expect(s).toEqual({ provider: "openstreetmap", url: OSM_TILE_URL, attribution: OSM_ATTRIBUTION, maxZoom: 19 });
    }
    expect(OSM_ATTRIBUTION).toContain("openstreetmap.org/copyright");
  });

  it("uses a custom URL when the provider is custom or unset, never when openstreetmap is chosen", () => {
    const url = "https://tiles.example.com/{z}/{x}/{y}.png";
    expect(mapTileSource("custom", url, "© Example")).toMatchObject({ provider: "custom", url, attribution: "© Example" });
    expect(mapTileSource(undefined, url)).toMatchObject({ provider: "custom", url, attribution: OSM_ATTRIBUTION });
    expect(mapTileSource("openstreetmap", url).url).toBe(OSM_TILE_URL);
    expect(mapTileSource("custom").provider).toBe("openstreetmap");
  });

  it("links to the spot on openstreetmap.org", () => {
    expect(osmLink(-27.4698, 153.0251)).toBe("https://www.openstreetmap.org/?mlat=-27.469800&mlon=153.025100#map=17/-27.469800/153.025100");
  });
});
