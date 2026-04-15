import { SENSITIVITY_MULTIPLIERS, SPECIES_SEASON_FACTOR, TRIGGER_ALIASES } from "@/lib/constants";
import { decodePolyline } from "@/lib/polyline";
import { lookupTreeCellsInRadius } from "@/lib/tree-grid";
import type {
  ExposureLevel,
  GoogleRoute,
  PollenSignal,
  RouteCandidate,
  RouteHotspot,
  TreeGridCell,
  UserProfile,
  WeatherSignal,
} from "@/lib/types";
import { clamp, exposureLevelFromScore, round, sampleRoutePoints } from "@/lib/utils";

/** Pedestrian exposure radius — trees within this distance affect the score. */
const TREE_EXPOSURE_RADIUS_METERS = 20;

/**
 * Fallback burden used when a route point falls outside the tree-grid coverage.
 * Represents a typical NYC street-level canopy baseline.
 */
const DEFAULT_BURDEN = 18;

interface RouteScoreResult {
  candidate: RouteCandidate;
  dominantArea: string;
  dominantLevel: ExposureLevel;
}

export function scoreRoutes(
  routes: GoogleRoute[],
  profile: UserProfile,
  weather: WeatherSignal,
  pollen: PollenSignal,
): RouteScoreResult[] {
  return routes
    .map((route, index) => scoreSingleRoute(route, index, profile, weather, pollen))
    .sort((a, b) => a.candidate.exposureScore - b.candidate.exposureScore);
}

function scoreSingleRoute(
  route: GoogleRoute,
  index: number,
  profile: UserProfile,
  weather: WeatherSignal,
  pollen: PollenSignal,
): RouteScoreResult {
  const points = decodePolyline(route.polyline);

  // Sample more points for longer routes (~1 sample per 120 m, capped at 40).
  const sampleCount = clamp(Math.round(route.distanceMeters / 120), 10, 40);
  const sampledPoints = sampleRoutePoints(points, sampleCount);

  const sensitivity = SENSITIVITY_MULTIPLIERS[profile.sensitivity];
  const treeMatches = profile.knowsTreeTriggers ? profile.triggers : [];
  const generalAvoidanceMode = !profile.knowsTreeTriggers || !treeMatches.length;
  const routeTimeBoost = clamp(route.durationMin / 36, 0.7, 1.25);
  const pollenFactor = getTreePollenFactor(pollen);
  const weatherBoost = getWeatherBoost(weather);
  const month = new Date().getMonth();

  let aggregateBurden = 0;
  let peakBurden = 0;
  let dominantArea = "NYC corridor";
  let dominantRisk = 0;
  const hotspots: RouteHotspot[] = [];

  sampledPoints.forEach((point, pointIndex) => {
    // Collect all tree-grid cells within the pedestrian exposure radius.
    const cells = lookupTreeCellsInRadius(point, TREE_EXPOSURE_RADIUS_METERS);

    let burden: number;
    let areaName = "NYC corridor";

    if (!cells.length) {
      // Point is outside grid coverage — use the baseline burden.
      burden = DEFAULT_BURDEN;
    } else {
      const merged = mergeCells(cells);
      areaName = merged.areaName;
      // Dampen species weights by their current-month pollen activity.
      const seasonalWeights = applySeasonality(merged.speciesWeights, month);
      const speciesBoost = getSpeciesMatchBoost(
        treeMatches,
        seasonalWeights,
        merged.topSpecies,
        generalAvoidanceMode,
      );
      burden = merged.canopyScore * speciesBoost;
    }

    aggregateBurden += burden;
    peakBurden = Math.max(peakBurden, burden);

    if (burden >= dominantRisk) {
      dominantRisk = burden;
      dominantArea = areaName;
    }

    hotspots.push({
      lat: point.lat,
      lng: point.lng,
      label: `${areaName} hotspot ${pointIndex + 1}`,
      risk: round(burden, 0),
    });
  });

  const normalizedBurden = sampledPoints.length ? aggregateBurden / sampledPoints.length : DEFAULT_BURDEN;

  // pollenFactor is multiplicative on the tree burden so high-pollen days
  // amplify route differences rather than just shifting every score equally.
  // Coefficients are calibrated so canopyScore=80 × maxBoost × maxPollenFactor
  // lands near the top of the scale without hitting the 98 ceiling.
  const treePart = normalizedBurden * 0.28 + peakBurden * 0.12;
  const score = clamp(
    (treePart * pollenFactor + routeTimeBoost * 3) * sensitivity * weatherBoost,
    8,
    98,
  );

  const exposureLevel = exposureLevelFromScore(score);
  const candidate: RouteCandidate = {
    id: route.id,
    label: `Route ${String.fromCharCode(65 + index)}`,
    polyline: route.polyline,
    durationMin: route.durationMin,
    distanceMeters: route.distanceMeters,
    exposureScore: round(score, 0),
    exposureLevel,
    explanation: "",
    rationale: buildRationale(exposureLevel, profile, dominantArea, weather, pollen),
    hotspots: hotspots
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 3),
  };

  return {
    candidate,
    dominantArea,
    dominantLevel: exposureLevel,
  };
}

/** Merge multiple overlapping cells into a single aggregate view. */
function mergeCells(cells: TreeGridCell[]): {
  canopyScore: number;
  speciesWeights: Record<string, number>;
  topSpecies: string[];
  areaName: string;
} {
  if (cells.length === 1) {
    return cells[0];
  }

  const canopyScore = cells.reduce((sum, c) => sum + c.canopyScore, 0) / cells.length;

  const allSpecies = new Set(cells.flatMap((c) => Object.keys(c.speciesWeights)));
  const speciesWeights: Record<string, number> = {};
  for (const species of allSpecies) {
    const avg = cells.reduce((sum, c) => sum + (c.speciesWeights[species] ?? 0), 0) / cells.length;
    if (avg > 0) speciesWeights[species] = Number(avg.toFixed(2));
  }

  const topSpecies = Object.entries(speciesWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([s]) => s);

  // Use the area name from the densest cell.
  const areaName = cells.reduce((best, c) => (c.canopyScore > best.canopyScore ? c : best)).areaName;

  return { canopyScore, speciesWeights, topSpecies, areaName };
}

/** Scale each species weight by its current-month pollen activity factor. */
function applySeasonality(speciesWeights: Record<string, number>, month: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(speciesWeights).map(([species, weight]) => {
      const factors = SPECIES_SEASON_FACTOR[species] ?? SPECIES_SEASON_FACTOR["tree"];
      return [species, weight * (factors[month] ?? 0.5)];
    }),
  );
}

/**
 * Convert the pollen signal into a multiplicative factor (1.0–1.5).
 * Tree pollen dominates; grass and weed contribute a small fraction.
 */
function getTreePollenFactor(pollen: PollenSignal): number {
  const index = pollen.treeIndex + pollen.grassIndex * 0.12 + pollen.weedIndex * 0.08;
  return clamp(1 + index * 0.083, 1.0, 1.5);
}

function getWeatherBoost(weather: WeatherSignal) {
  const windFactor = 1 + weather.windSpeedMph / 55;
  const humidityFactor = 1 - clamp((weather.humidity - 40) / 220, 0, 0.22);
  const temperatureFactor = weather.temperatureF >= 75 ? 1.05 : weather.temperatureF <= 45 ? 0.95 : 1;
  return clamp(windFactor * humidityFactor * temperatureFactor, 0.86, 1.34);
}

function getSpeciesMatchBoost(
  triggers: string[],
  speciesWeights: Record<string, number>,
  topSpecies: string[],
  generalAvoidanceMode: boolean,
) {
  if (generalAvoidanceMode) {
    const totalWeight = Object.values(speciesWeights).reduce((total, weight) => total + weight, 0);
    return clamp(0.95 + totalWeight * 0.55, 0.95, 1.55);
  }

  const matchedWeight = Object.entries(speciesWeights).reduce((total, [species, weight]) => {
    const isDirectTrigger = triggers.includes(species);
    const isAliasMatch = triggers.some((trigger) => {
      const aliases = TRIGGER_ALIASES[trigger] ?? [];
      return aliases.some((alias) => species.includes(alias));
    });

    return total + (isDirectTrigger || isAliasMatch ? weight : weight * 0.45);
  }, 0);

  const topSpeciesBoost = topSpecies.some((species) =>
    triggers.some((trigger) => species.toLowerCase().includes(trigger.toLowerCase())),
  )
    ? 0.3
    : 0;

  return clamp(0.9 + matchedWeight + topSpeciesBoost, 0.8, 2.1);
}

function buildRationale(
  level: ExposureLevel,
  profile: UserProfile,
  areaName: string,
  weather: WeatherSignal,
  pollen: PollenSignal,
) {
  const lines = [`${areaName} has elevated street-tree density relative to nearby blocks.`];

  if (profile.knowsTreeTriggers && profile.triggers.length) {
    lines.push(`This route is ranked against your selected tree triggers: ${profile.triggers.slice(0, 3).join(", ")}.`);
  } else {
    lines.push("No tree species were selected, so this route minimizes overall contact with trees.");
  }

  if (pollen.treeIndex >= 4 || weather.windSpeedMph >= 12) {
    lines.push(
      `Tree pollen is elevated and wind is around ${round(weather.windSpeedMph, 0)} mph, so spread risk is higher on exposed blocks.`,
    );
  } else if (level === "low") {
    lines.push("This route trades a bit of time for meaningfully lower tree-contact exposure.");
  } else {
    lines.push("This option keeps you closer to denser canopy pockets for more of the walk.");
  }

  return lines;
}
