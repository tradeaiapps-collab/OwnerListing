import { describe, expect, it } from "vitest";
import { clusterPoints, MAX_CLUSTER_ZOOM, project, shortPrice } from "../src/domain/map-cluster";
import { parseBbox, parseSearchQuery, matchesQuery } from "../src/domain/listing-search";
import { parseDetails } from "../src/domain/listing-details";
import { buildSearch } from "../src/server/listing-search-sql";
import type { PropertyListing } from "../src/domain/listing";

const pt = (id: string, latitude: number, longitude: number) => ({ id, latitude, longitude });
// Paddington and New Farm (Brisbane, ~3 km apart), Bondi (Sydney).
const brisbaneA = pt("a", -27.4598, 152.9996), brisbaneB = pt("b", -27.4671, 153.0497), sydney = pt("c", -33.8915, 151.2767);

describe("project", () => {
  it("puts lng 0 / lat 0 at the centre of the world and doubles per zoom", () => {
    expect(project(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(project(0, 0, 3)).toEqual({ x: 1024, y: 1024 });
  });
  it("goes south as y grows", () => {
    expect(project(-33, 151, 5).y).toBeGreaterThan(project(-27, 151, 5).y);
  });
});

describe("clusterPoints", () => {
  it("groups nearby pins at a city zoom and keeps distant ones apart", () => {
    const g = clusterPoints([brisbaneA, brisbaneB, sydney], 6);
    expect(g).toHaveLength(2);
    const cluster = g.find(x => x.kind === "cluster");
    expect(cluster && cluster.kind === "cluster" && cluster.count).toBe(2);
    expect(cluster && cluster.kind === "cluster" && cluster.ids).toEqual(["a", "b"]);
    expect(cluster && cluster.kind === "cluster" && cluster.bounds).toEqual({ south: -27.4671, west: 152.9996, north: -27.4598, east: 153.0497 });
  });
  it("splits the cluster when zoomed in to suburb level", () => {
    expect(clusterPoints([brisbaneA, brisbaneB], 14).every(g => g.kind === "pin")).toBe(true);
  });
  it("never clusters at street zoom, even on the same spot", () => {
    expect(clusterPoints([brisbaneA, { ...brisbaneA, id: "a2" }], MAX_CLUSTER_ZOOM)).toHaveLength(2);
  });
  it("is stable for the same input order or a shuffled one", () => {
    const one = clusterPoints([brisbaneA, brisbaneB, sydney], 4);
    const two = clusterPoints([sydney, brisbaneB, brisbaneA], 4);
    expect(two).toEqual(one);
  });
  it("returns nothing for no points", () => {
    expect(clusterPoints([], 5)).toEqual([]);
  });
});

describe("shortPrice", () => {
  it("shortens sale prices and keeps weekly rent", () => {
    expect(shortPrice(82_500_000, "sale")).toBe("$825k");
    expect(shortPrice(125_000_000, "sale")).toBe("$1.25m");
    expect(shortPrice(65_000, "rent")).toBe("$650/wk");
  });
});

describe("map location on a listing", () => {
  it("accepts a pair inside Australia and clears with nulls", () => {
    expect(parseDetails({ latitude: -27.4598, longitude: 152.9996 }, "sale")).toEqual({ ok: true, value: { latitude: -27.4598, longitude: 152.9996 } });
    expect(parseDetails({ latitude: null, longitude: null }, "sale")).toEqual({ ok: true, value: { latitude: null, longitude: null } });
  });
  it("rejects half a pair, places outside Australia, junk and false precision", () => {
    for (const bad of [
      { latitude: -27.5 }, { longitude: 153 }, { latitude: -27.5, longitude: null },
      { latitude: 51.5, longitude: -0.12 }, { latitude: "-27.5", longitude: "153" },
      { latitude: -27.1234567, longitude: 153 }, { latitude: NaN, longitude: 153 }
    ]) expect(parseDetails(bad, "sale").ok).toBe(false);
  });
});

describe("bbox search filter", () => {
  it("parses south,west,north,east and drops bad boxes", () => {
    expect(parseBbox("-28,152.5,-27,153.5")).toEqual({ south: -28, west: 152.5, north: -27, east: 153.5 });
    for (const bad of ["", "1,2,3", "-27,152,-28,153", "a,b,c,d", "-28,152,-27,200", "-28,153,-27,152"]) expect(parseBbox(bad)).toBeUndefined();
    expect(parseSearchQuery(new URLSearchParams("bbox=-28,152.5,-27,153.5")).bbox).toEqual({ south: -28, west: 152.5, north: -27, east: 153.5 });
  });
  it("matches only pinned listings inside the box", () => {
    const base = { id: "x", status: "published" } as PropertyListing;
    const q = { sort: "newest" as const, page: 1, pageSize: 12, bbox: { south: -28, west: 152.5, north: -27, east: 153.5 } };
    expect(matchesQuery({ ...base, latitude: -27.46, longitude: 153 }, q)).toBe(true);
    expect(matchesQuery({ ...base, latitude: -33.89, longitude: 151.28 }, q)).toBe(false);
    expect(matchesQuery(base, q)).toBe(false);
    expect(matchesQuery(base, { sort: "newest", page: 1, pageSize: 12, located: true })).toBe(false);
  });
  it("puts box values in parameters, never in the SQL text", () => {
    const { where, params } = buildSearch({ sort: "newest", page: 1, pageSize: 12, bbox: { south: -28, west: 152.5, north: -27, east: 153.5 } });
    expect(where).toContain("l.latitude IS NOT NULL");
    expect(where).not.toContain("152.5");
    expect(params).toEqual([-28, -27, 152.5, 153.5]);
  });
});
