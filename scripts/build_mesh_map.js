const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data", "raw");
const PROCESSED = path.join(ROOT, "data", "processed");
const OUTPUT = path.join(ROOT, "output");
const DIST = path.join(ROOT, "dist");

const YEARS = [
  { year: 2010, stat: "T000608", populationColumn: "T000608001", householdColumn: "T000608004", source: "平成22年国勢調査 3次メッシュ 男女別人口総数及び世帯総数" },
  { year: 2015, stat: "T000846", populationColumn: "T000846001", householdColumn: "T000846025", source: "平成27年国勢調査 3次メッシュ 人口等基本集計に関する事項" },
  { year: 2020, stat: "T001100", populationColumn: "T001100001", householdColumn: "T001100034", source: "令和2年国勢調査 3次メッシュ 人口及び世帯" },
];

const PRIMARY_CODES = ["5238", "5338", "5339"];
const PREF_REFERENCE_ZIPS = [
  path.join(RAW, "test_2015_19.zip"),
  path.join(RAW, "test_2020_19.zip"),
];
const OSM_BUILDINGS_PATH = path.join(RAW, "osm_hokuto_buildings_overpass.json");
const RESIDENTIAL_BUILDING_TAGS = new Set(["house", "residential", "apartments", "detached", "semidetached_house", "terrace"]);

fs.mkdirSync(PROCESSED, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

function unzipText(zipPath) {
  return execFileSync("unzip", ["-p", zipPath], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function parseCsvLine(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

function readMeshStats(zipPath, populationColumn, householdColumn) {
  const text = unzipText(zipPath).replace(/\r/g, "");
  const lines = text.split("\n").filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const keyIndex = header.indexOf("KEY_CODE");
  const populationIndex = header.indexOf(populationColumn);
  const householdIndex = header.indexOf(householdColumn);
  if (keyIndex === -1 || populationIndex === -1 || householdIndex === -1) {
    throw new Error(`Required columns not found in ${zipPath}`);
  }
  const rows = new Map();
  for (const line of lines.slice(2)) {
    const cols = parseCsvLine(line);
    const key = cols[keyIndex];
    const population = Number(cols[populationIndex]);
    const households = Number(cols[householdIndex]);
    if (/^\d{8}$/.test(key) && Number.isFinite(population)) {
      rows.set(key, {
        population,
        households: Number.isFinite(households) ? households : 0,
      });
    }
  }
  return rows;
}

function meshBounds(code) {
  const p = Number(code.slice(0, 2));
  const q = Number(code.slice(2, 4));
  const r = Number(code[4]);
  const s = Number(code[5]);
  const t = Number(code[6]);
  const u = Number(code[7]);
  const lat = (p * 40) / 60 + (r * 5) / 60 + (t * 30) / 3600;
  const lon = q + 100 + (s * 7.5) / 60 + (u * 45) / 3600;
  const dLat = 30 / 3600;
  const dLon = 45 / 3600;
  return { west: lon, south: lat, east: lon + dLon, north: lat + dLat };
}

function meshAreaKm2(bounds) {
  const radiusKm = 6371.0088;
  const deg = Math.PI / 180;
  return (
    radiusKm * radiusKm *
    Math.abs(Math.sin(bounds.north * deg) - Math.sin(bounds.south * deg)) *
    Math.abs((bounds.east - bounds.west) * deg)
  );
}

function meshPolygon(bounds) {
  return [[
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
    [bounds.west, bounds.south],
  ]];
}

function center(bounds) {
  return [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function pointInGeometry(point, geometry) {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((poly) => pointInPolygon(point, poly));
  return false;
}

function collectPrefKeys() {
  const keys = new Set();
  for (const zip of PREF_REFERENCE_ZIPS) {
    if (!fs.existsSync(zip)) continue;
    const text = unzipText(zip).replace(/\r/g, "");
    for (const line of text.split("\n").slice(2)) {
      const key = line.split(",", 1)[0];
      if (/^\d{8}$/.test(key)) keys.add(key);
    }
  }
  return keys;
}

function meshCodeFromPoint(lon, lat) {
  const p = Math.floor(lat * 60 / 40);
  const q = Math.floor(lon - 100);
  const lat1 = lat - (p * 40) / 60;
  const lon1 = lon - 100 - q;
  const r = Math.floor(lat1 * 60 / 5);
  const s = Math.floor(lon1 * 60 / 7.5);
  const lat2 = lat1 - (r * 5) / 60;
  const lon2 = lon1 - (s * 7.5) / 60;
  const t = Math.floor(lat2 * 3600 / 30);
  const u = Math.floor(lon2 * 3600 / 45);
  return `${String(p).padStart(2, "0")}${String(q).padStart(2, "0")}${r}${s}${t}${u}`;
}

function aggregateOsmBuildings(hokutoGeometry) {
  const byMesh = new Map();
  const summary = { total: 0, inHokuto: 0, residentialTagged: 0, unknownTagged: 0 };
  if (!fs.existsSync(OSM_BUILDINGS_PATH)) {
    return { byMesh, summary };
  }

  const osm = JSON.parse(fs.readFileSync(OSM_BUILDINGS_PATH, "utf8"));
  for (const element of osm.elements || []) {
    const centerPoint = element.center ? [element.center.lon, element.center.lat] : null;
    if (!centerPoint || !Number.isFinite(centerPoint[0]) || !Number.isFinite(centerPoint[1])) continue;
    summary.total += 1;
    if (!pointInGeometry(centerPoint, hokutoGeometry)) continue;
    summary.inHokuto += 1;

    const tag = element.tags?.building || "yes";
    const meshCode = meshCodeFromPoint(centerPoint[0], centerPoint[1]);
    if (!byMesh.has(meshCode)) {
      byMesh.set(meshCode, { total: 0, residentialTagged: 0, unknownTagged: 0, tags: {} });
    }
    const stats = byMesh.get(meshCode);
    stats.total += 1;
    stats.tags[tag] = (stats.tags[tag] || 0) + 1;
    if (RESIDENTIAL_BUILDING_TAGS.has(tag)) {
      stats.residentialTagged += 1;
      summary.residentialTagged += 1;
    }
    if (tag === "yes") {
      stats.unknownTagged += 1;
      summary.unknownTagged += 1;
    }
  }
  return { byMesh, summary };
}

function buildData() {
  const yamanashiKeys = collectPrefKeys();
  const byMesh = new Map();

  for (const meta of YEARS) {
    const rows = new Map();
    const prefZip = path.join(RAW, `test_${meta.year}_19.zip`);
    if (fs.existsSync(prefZip) && meta.year !== 2010) {
      for (const [key, stats] of readMeshStats(prefZip, meta.populationColumn, meta.householdColumn)) rows.set(key, stats);
    } else {
      for (const primary of PRIMARY_CODES) {
        const zip = path.join(RAW, `pop_${meta.year}_${primary}.zip`);
        for (const [key, stats] of readMeshStats(zip, meta.populationColumn, meta.householdColumn)) {
          if (yamanashiKeys.has(key)) rows.set(key, stats);
        }
      }
    }
    for (const [key, stats] of rows) {
      if (!byMesh.has(key)) {
        const bounds = meshBounds(key);
        byMesh.set(key, { key, bounds, areaKm2: meshAreaKm2(bounds), populations: {}, households: {} });
      }
      byMesh.get(key).populations[meta.year] = stats.population;
      byMesh.get(key).households[meta.year] = stats.households;
    }
  }

  const hokuto = JSON.parse(fs.readFileSync(path.join(RAW, "hokuto_2020.geojson"), "utf8"));
  const hokutoGeometry = hokuto.features[0].geometry;
  const osmBuildings = aggregateOsmBuildings(hokutoGeometry);

  for (const meshCode of osmBuildings.byMesh.keys()) {
    if (!byMesh.has(meshCode)) {
      const bounds = meshBounds(meshCode);
      byMesh.set(meshCode, { key: meshCode, bounds, areaKm2: meshAreaKm2(bounds), populations: {}, households: {} });
    }
  }

  const features = [...byMesh.values()]
    .filter((mesh) => YEARS.some((meta) => mesh.populations[meta.year] > 0) || (osmBuildings.byMesh.get(mesh.key)?.total || 0) > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((mesh) => {
      const densities = {};
      for (const meta of YEARS) {
        const pop = mesh.populations[meta.year];
        densities[meta.year] = Number.isFinite(pop) ? +(pop / mesh.areaKm2).toFixed(1) : null;
      }
      return {
        type: "Feature",
        properties: {
          mesh_code: mesh.key,
          area_km2: +mesh.areaKm2.toFixed(4),
          is_hokuto: pointInGeometry(center(mesh.bounds), hokutoGeometry),
          population: mesh.populations,
          households: mesh.households,
          density_per_km2: densities,
          change_2010_2020: (mesh.populations[2020] ?? 0) - (mesh.populations[2010] ?? 0),
          household_change_2010_2020: (mesh.households[2020] ?? 0) - (mesh.households[2010] ?? 0),
          building_proxy: (() => {
            const buildingStats = osmBuildings.byMesh.get(mesh.key) || { total: 0, residentialTagged: 0, unknownTagged: 0, tags: {} };
            const pop2020 = mesh.populations[2020] ?? 0;
            const peoplePerBuilding = buildingStats.total > 0 ? +(pop2020 / buildingStats.total).toFixed(2) : null;
            const buildingsPer100People = pop2020 > 0 ? +((buildingStats.total / pop2020) * 100).toFixed(1) : (buildingStats.total > 0 ? null : 0);
            return {
              total_buildings: buildingStats.total,
              residential_tagged_buildings: buildingStats.residentialTagged,
              unknown_tagged_buildings: buildingStats.unknownTagged,
              has_hokuto_buildings: buildingStats.total > 0,
              people_per_building_2020: peoplePerBuilding,
              buildings_per_100_people_2020: buildingsPer100People,
              top_building_tags: Object.entries(buildingStats.tags).sort((a, b) => b[1] - a[1]).slice(0, 5),
            };
          })(),
        },
        geometry: { type: "Polygon", coordinates: meshPolygon(mesh.bounds) },
      };
    });

  const geojson = {
    type: "FeatureCollection",
    name: "yamanashi_1km_population_mesh",
    metadata: {
      created: new Date().toISOString(),
      years: YEARS,
      density_definition: "population divided by geodetic area of each 3rd-level standard mesh rectangle",
      hokuto_definition: "mesh whose centroid falls inside the 2020 Hokuto city boundary",
      sources: [
        "e-Stat 統計地理情報システム 地域メッシュ統計",
        "Geoshape 歴史的行政区域データセットβ版 / 国土数値情報 行政区域データ",
        "OpenStreetMap building features via Overpass API",
      ],
      building_proxy: {
        definition: "OSM building centroids inside Hokuto city aggregated to 1km meshes. Vacation-home-likeness is approximated by low 2020 resident population per building.",
        osm_summary: osmBuildings.summary,
      },
    },
    features,
  };

  fs.writeFileSync(path.join(PROCESSED, "mesh_population.geojson"), JSON.stringify(geojson));
  fs.writeFileSync(path.join(PROCESSED, "mesh_population_pretty.geojson"), JSON.stringify(geojson, null, 2));
  return geojson;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function buildHtml(geojson) {
  const data = JSON.stringify(geojson);
  const hokutoBoundary = fs.readFileSync(path.join(RAW, "hokuto_2020.geojson"), "utf8");
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>山梨県・北杜市 1km人口密度メッシュ</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    :root { color-scheme: light; --ink:#18212f; --muted:#667085; --line:#d7dde8; --bg:#f5f7fb; --panel:#ffffff; --accent:#0f766e; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 18px 22px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.25; letter-spacing: 0; }
    .sub { margin: 0; color: var(--muted); font-size: 13px; }
    main { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 76px); }
    aside { padding: 18px; border-right: 1px solid var(--line); background: var(--panel); }
    .control { margin-bottom: 18px; }
    .label { display: block; margin-bottom: 8px; font-weight: 700; font-size: 13px; }
    .segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .segments.modes { grid-template-columns: repeat(2, 1fr); }
    .segments.two { grid-template-columns: repeat(2, 1fr); }
    .segments.pairs { grid-template-columns: 1fr; }
    button { border: 1px solid var(--line); background: #fff; color: var(--ink); min-height: 36px; border-radius: 6px; font-weight: 700; cursor: pointer; }
    button.active { border-color: var(--accent); background: #e7f6f3; color: #075f58; }
    .toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .stat { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 9px 0; border-bottom: 1px solid #edf0f5; font-size: 13px; }
    .stat strong { font-size: 15px; }
    .legend { display: grid; gap: 7px; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .swatch { display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: center; }
    .chip { width: 22px; height: 14px; border: 1px solid rgba(0,0,0,.12); }
    .note { margin-top: 18px; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .map-wrap { position: relative; overflow: hidden; background: #eef3f6; }
    #map { width: 100%; min-height: calc(100vh - 76px); height: calc(100vh - 76px); }
    .leaflet-container { font: inherit; background: #eef3f6; }
    .leaflet-control-zoom a { color: var(--ink); }
    .mesh-popup { min-width: 210px; font-size: 12px; line-height: 1.45; }
    .mesh-popup b { font-size: 13px; }
    .mesh-label-icon { background: transparent; border: 0; }
    .mesh-label {
      display: block;
      min-width: 34px;
      text-align: center;
      color: rgba(17, 24, 39, .48);
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
      text-shadow: 0 1px 2px rgba(255,255,255,.95), 0 -1px 2px rgba(255,255,255,.85), 1px 0 2px rgba(255,255,255,.85), -1px 0 2px rgba(255,255,255,.85);
      pointer-events: none;
      transform: translate(-50%, -50%);
      user-select: none;
      white-space: nowrap;
    }
    .leaflet-interactive { outline: none; }
    @media (max-width: 780px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      #map { min-height: 68vh; height: 68vh; }
    }
  </style>
</head>
<body>
<header>
  <h1>山梨県・北杜市 1km人口密度メッシュ</h1>
  <p class="sub">2010・2015・2020年の国勢調査地域メッシュ統計。密度は各3次メッシュの人口 ÷ メッシュ面積(km²)。</p>
</header>
<main>
  <aside>
    <div class="control">
      <span class="label">表示モード</span>
      <div class="segments modes">
        <button id="modeDensity" class="active">人口密度</button>
        <button id="modeChange">増減</button>
        <button id="modeHouseholds">世帯数</button>
        <button id="modeHouseholdChange">世帯増減</button>
        <button id="modeVilla">別荘推定</button>
      </div>
    </div>
    <div class="control">
      <span class="label">年度</span>
      <div class="segments" id="yearButtons"></div>
    </div>
    <div class="control" id="changeControl">
      <span class="label">比較期間</span>
      <div class="segments pairs" id="changeButtons"></div>
    </div>
    <div class="control">
      <span class="label">表示範囲</span>
      <div class="toggle">
        <button id="scopeYamanashi">山梨県</button>
        <button id="scopeHokuto" class="active">北杜市</button>
      </div>
    </div>
    <div class="control">
      <span class="label">メッシュ数値</span>
      <div class="toggle">
        <button id="labelsOn">表示</button>
        <button id="labelsOff" class="active">非表示</button>
      </div>
    </div>
    <div class="control">
      <span class="label">表示中の概要</span>
      <div id="stats"></div>
    </div>
    <div class="control">
      <span class="label">人口密度（人/km²）</span>
      <div id="legend" class="legend"></div>
    </div>
    <p class="note">北杜市は2020年行政区域の境界にメッシュ中心点が含まれるものを抽出しています。別荘推定はOSM建物数と2020年人口からの近似で、実際の別荘戸数ではありません。</p>
  </aside>
  <section class="map-wrap">
    <div id="map" role="img" aria-label="山梨県と北杜市の1km人口密度メッシュマップ"></div>
  </section>
</main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const geo = ${data};
const hokutoBoundary = ${hokutoBoundary};
const years = [2010, 2015, 2020];
const changePairs = [
  { from: 2010, to: 2020 },
  { from: 2010, to: 2015 },
  { from: 2015, to: 2020 },
];
let currentYear = 2020;
let mode = "density";
let changePair = changePairs[0];
let scope = "hokuto";
let showLabels = false;
const densityPalette = ["#fff7ec","#fee8c8","#fdd49e","#fdbb84","#fc8d59","#e34a33","#b30000"];
const densityBreaks = [0, 25, 50, 100, 250, 500, 1000, Infinity];
const householdPalette = ["#f7fcf5","#e5f5e0","#c7e9c0","#a1d99b","#74c476","#31a354","#006d2c"];
const householdBreaks = [0, 10, 25, 50, 100, 250, 500, Infinity];
const changePalette = ["#2166ac","#67a9cf","#d1e5f0","#f7f7f7","#fddbc7","#ef8a62","#b2182b"];
const changeBreaks = [-Infinity, -100, -50, -10, 10, 50, 100, Infinity];
const householdChangeBreaks = [-Infinity, -50, -25, -10, 10, 25, 50, Infinity];
const villaPalette = ["#f7f7f7","#fee8c8","#fdbb84","#fc8d59","#e34a33","#b30000"];
const villaScoreBreaks = [-Infinity, 0, 10, 25, 50, 100, Infinity];
let meshLayer;
let boundaryLayer;
let labelLayer;

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
  minZoom: 8,
  maxZoom: 15,
});

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

function colorFor(value) {
  for (let i = 0; i < densityBreaks.length - 1; i++) {
    if (value >= densityBreaks[i] && value < densityBreaks[i + 1]) return densityPalette[i];
  }
  return densityPalette[0];
}

function householdColorFor(value) {
  for (let i = 0; i < householdBreaks.length - 1; i++) {
    if (value >= householdBreaks[i] && value < householdBreaks[i + 1]) return householdPalette[i];
  }
  return householdPalette[0];
}

function changeColorFor(value) {
  const breaks = mode === "householdChange" ? householdChangeBreaks : changeBreaks;
  for (let i = 0; i < breaks.length - 1; i++) {
    if (value >= breaks[i] && value < breaks[i + 1]) return changePalette[i];
  }
  return changePalette[3];
}

function villaColorFor(score) {
  for (let i = 0; i < villaScoreBreaks.length - 1; i++) {
    if (score >= villaScoreBreaks[i] && score < villaScoreBreaks[i + 1]) return villaPalette[i];
  }
  return villaPalette[0];
}

function signed(value, unit) {
  const sign = value > 0 ? "+" : "";
  return sign + Number(value).toLocaleString("ja-JP") + unit;
}

function featurePopulation(f, year) {
  return f.properties.population[year] || 0;
}

function featureHouseholds(f, year) {
  return f.properties.households[year] || 0;
}

function featureDensity(f, year) {
  return f.properties.density_per_km2[year] || 0;
}

function formatNullable(value, formatter) {
  return value === null || value === undefined ? "--" : formatter(value);
}

function populationChange(f) {
  return featurePopulation(f, changePair.to) - featurePopulation(f, changePair.from);
}

function householdChange(f) {
  return featureHouseholds(f, changePair.to) - featureHouseholds(f, changePair.from);
}

function densityChange(f) {
  return featureDensity(f, changePair.to) - featureDensity(f, changePair.from);
}

function buildingProxy(f) {
  return f.properties.building_proxy || {
    total_buildings: 0,
    residential_tagged_buildings: 0,
    unknown_tagged_buildings: 0,
    has_hokuto_buildings: false,
    people_per_building_2020: null,
    buildings_per_100_people_2020: 0,
    top_building_tags: [],
  };
}

function villaScore(f) {
  const proxy = buildingProxy(f);
  const pop = featurePopulation(f, 2020);
  if (proxy.total_buildings <= 0) return 0;
  if (pop <= 0) return 999;
  return proxy.total_buildings / pop * 100;
}

function renderControls() {
  document.getElementById("modeDensity").classList.toggle("active", mode === "density");
  document.getElementById("modeChange").classList.toggle("active", mode === "change");
  document.getElementById("modeHouseholds").classList.toggle("active", mode === "households");
  document.getElementById("modeHouseholdChange").classList.toggle("active", mode === "householdChange");
  document.getElementById("modeVilla").classList.toggle("active", mode === "villa");
  document.getElementById("modeDensity").onclick = () => { mode = "density"; render(); };
  document.getElementById("modeChange").onclick = () => { mode = "change"; render(); };
  document.getElementById("modeHouseholds").onclick = () => { mode = "households"; render(); };
  document.getElementById("modeHouseholdChange").onclick = () => { mode = "householdChange"; render(); };
  document.getElementById("modeVilla").onclick = () => { mode = "villa"; render(); };

  document.getElementById("yearButtons").innerHTML = years.map(y => '<button class="' + (y === currentYear ? "active" : "") + '" data-year="' + y + '">' + y + '</button>').join("");
  document.querySelectorAll("[data-year]").forEach(btn => btn.addEventListener("click", () => {
    currentYear = Number(btn.dataset.year);
    if (mode !== "households") mode = "density";
    render();
  }));
  document.getElementById("yearButtons").parentElement.style.display = mode === "density" || mode === "households" ? "" : "none";

  document.getElementById("changeButtons").innerHTML = changePairs.map(pair => {
    const active = pair.from === changePair.from && pair.to === changePair.to;
    return '<button class="' + (active ? "active" : "") + '" data-from="' + pair.from + '" data-to="' + pair.to + '">' + pair.from + ' → ' + pair.to + '</button>';
  }).join("");
  document.querySelectorAll("[data-from]").forEach(btn => btn.addEventListener("click", () => {
    changePair = { from: Number(btn.dataset.from), to: Number(btn.dataset.to) };
    if (mode !== "householdChange") mode = "change";
    render();
  }));
  document.getElementById("changeControl").style.display = mode === "change" || mode === "householdChange" ? "" : "none";

  document.getElementById("scopeYamanashi").onclick = () => { scope = "yamanashi"; render(); };
  document.getElementById("scopeHokuto").onclick = () => { scope = "hokuto"; render(); };
  document.getElementById("labelsOn").onclick = () => { showLabels = true; render(); };
  document.getElementById("labelsOff").onclick = () => { showLabels = false; render(); };
}

function selectedFeatures() {
  return geo.features.filter(inCurrentScope);
}

function inCurrentScope(f) {
  if (scope === "yamanashi") return true;
  if (f.properties.is_hokuto) return true;
  return mode === "villa" && buildingProxy(f).has_hokuto_buildings;
}

function geoJsonBounds(features) {
  return L.geoJSON({ type: "FeatureCollection", features }).getBounds();
}

function renderStats(features) {
  const area = features.reduce((sum, f) => sum + f.properties.area_km2, 0);
  if (mode === "density") {
    const pop = features.reduce((sum, f) => sum + featurePopulation(f, currentYear), 0);
    const density = pop / area;
    const nonzero = features.filter(f => featurePopulation(f, currentYear) > 0).length;
    document.getElementById("stats").innerHTML = [
      ["メッシュ数", nonzero.toLocaleString("ja-JP")],
      ["人口合計", Math.round(pop).toLocaleString("ja-JP") + " 人"],
      ["平均密度", density.toFixed(1).toLocaleString("ja-JP") + " 人/km²"],
    ].map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join("");
    return;
  }

  if (mode === "households") {
    const households = features.reduce((sum, f) => sum + featureHouseholds(f, currentYear), 0);
    const density = households / area;
    const nonzero = features.filter(f => featureHouseholds(f, currentYear) > 0).length;
    document.getElementById("stats").innerHTML = [
      ["メッシュ数", nonzero.toLocaleString("ja-JP")],
      ["世帯数合計", Math.round(households).toLocaleString("ja-JP") + " 世帯"],
      ["平均世帯密度", density.toFixed(1).toLocaleString("ja-JP") + " 世帯/km²"],
    ].map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join("");
    return;
  }

  if (mode === "villa") {
    const buildingMeshes = features.filter(f => buildingProxy(f).total_buildings > 0);
    const totalBuildings = features.reduce((sum, f) => sum + buildingProxy(f).total_buildings, 0);
    const residentialTagged = features.reduce((sum, f) => sum + buildingProxy(f).residential_tagged_buildings, 0);
    const pop = features.reduce((sum, f) => sum + featurePopulation(f, 2020), 0);
    const peoplePerBuilding = totalBuildings > 0 ? pop / totalBuildings : 0;
    document.getElementById("stats").innerHTML = [
      ["建物ありメッシュ", buildingMeshes.length.toLocaleString("ja-JP")],
      ["OSM建物数", totalBuildings.toLocaleString("ja-JP")],
      ["住宅系タグ数", residentialTagged.toLocaleString("ja-JP")],
      ["人口/建物", peoplePerBuilding.toFixed(2).toLocaleString("ja-JP") + " 人/棟"],
    ].map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join("");
    return;
  }

  const isHouseholdChange = mode === "householdChange";
  const fromValue = features.reduce((sum, f) => sum + (isHouseholdChange ? featureHouseholds(f, changePair.from) : featurePopulation(f, changePair.from)), 0);
  const toValue = features.reduce((sum, f) => sum + (isHouseholdChange ? featureHouseholds(f, changePair.to) : featurePopulation(f, changePair.to)), 0);
  const changed = features.filter(f => (isHouseholdChange ? householdChange(f) : populationChange(f)) !== 0).length;
  const densityDelta = (toValue - fromValue) / area;
  const unit = isHouseholdChange ? " 世帯" : " 人";
  const densityUnit = isHouseholdChange ? " 世帯/km²" : " 人/km²";
  document.getElementById("stats").innerHTML = [
    ["比較期間", changePair.from + " → " + changePair.to],
    [isHouseholdChange ? "世帯増減" : "人口増減", signed(Math.round(toValue - fromValue), unit)],
    ["平均密度差", signed(densityDelta.toFixed(1), densityUnit)],
    ["変化ありメッシュ", changed.toLocaleString("ja-JP")],
  ].map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join("");
}

function renderLegend() {
  const labels = mode === "density"
    ? ["0-25", "25-50", "50-100", "100-250", "250-500", "500-1,000", "1,000+"]
    : mode === "households"
      ? ["0-10", "10-25", "25-50", "50-100", "100-250", "250-500", "500+"]
    : mode === "change"
      ? ["-100以下", "-100 - -50", "-50 - -10", "-10 - +10", "+10 - +50", "+50 - +100", "+100以上"]
    : mode === "householdChange"
      ? ["-50以下", "-50 - -25", "-25 - -10", "-10 - +10", "+10 - +25", "+25 - +50", "+50以上"]
      : ["建物なし", "0-10", "10-25", "25-50", "50-100", "100+"];
  const palette = mode === "density" ? densityPalette : mode === "households" ? householdPalette : mode === "change" || mode === "householdChange" ? changePalette : villaPalette;
  document.querySelector(".control .label + #legend");
  document.getElementById("legend").previousElementSibling.textContent =
    mode === "density" ? "人口密度（人/km²）" : mode === "households" ? "世帯数（世帯/メッシュ）" : mode === "change" ? "人口増減（人）" : mode === "householdChange" ? "世帯増減（世帯）" : "建物数/100人";
  document.getElementById("legend").innerHTML = labels.map((label, i) => '<div class="swatch"><span class="chip" style="background:' + palette[i] + '"></span><span>' + label + '</span></div>').join("");
}

function popupHtml(f) {
  const p = f.properties;
  if (mode === "villa") {
    const proxy = buildingProxy(f);
    const pop = featurePopulation(f, 2020);
    const score = villaScore(f);
    const peoplePerBuilding = proxy.people_per_building_2020 === null ? "人口0または建物なし" : Number(proxy.people_per_building_2020).toLocaleString("ja-JP") + " 人/棟";
    const tagSummary = proxy.top_building_tags.length
      ? proxy.top_building_tags.map(([tag, count]) => tag + ":" + count).join(", ")
      : "なし";
    return '<div class="mesh-popup"><b>メッシュ ' + p.mesh_code + '</b><br>' +
      (p.is_hokuto ? '北杜市内' : '山梨県内') + '<br>' +
      '2020年人口: ' + Math.round(pop).toLocaleString("ja-JP") + ' 人<br>' +
      'OSM建物数: ' + proxy.total_buildings.toLocaleString("ja-JP") + ' 棟<br>' +
      '住宅系タグ数: ' + proxy.residential_tagged_buildings.toLocaleString("ja-JP") + ' 棟<br>' +
      '人口/建物: ' + peoplePerBuilding + '<br>' +
      '建物数/100人: ' + (score >= 999 ? '人口0で建物あり' : score.toFixed(1).toLocaleString("ja-JP")) + '<br>' +
      '主なbuildingタグ: ' + tagSummary + '</div>';
  }

  if (mode === "change") {
    const fromPop = featurePopulation(f, changePair.from);
    const toPop = featurePopulation(f, changePair.to);
    const popDiff = toPop - fromPop;
    const denDiff = densityChange(f);
    return '<div class="mesh-popup"><b>メッシュ ' + p.mesh_code + '</b><br>' +
      (p.is_hokuto ? '北杜市内' : '山梨県内') + '<br>' +
      changePair.from + '年人口: ' + Math.round(fromPop).toLocaleString("ja-JP") + ' 人<br>' +
      changePair.to + '年人口: ' + Math.round(toPop).toLocaleString("ja-JP") + ' 人<br>' +
      '人口増減: ' + signed(Math.round(popDiff), ' 人') + '<br>' +
      '密度差: ' + signed(denDiff.toFixed(1), ' 人/km²') + '</div>';
  }

  if (mode === "householdChange") {
    const fromHouseholds = featureHouseholds(f, changePair.from);
    const toHouseholds = featureHouseholds(f, changePair.to);
    const diff = toHouseholds - fromHouseholds;
    return '<div class="mesh-popup"><b>メッシュ ' + p.mesh_code + '</b><br>' +
      (p.is_hokuto ? '北杜市内' : '山梨県内') + '<br>' +
      changePair.from + '年世帯数: ' + Math.round(fromHouseholds).toLocaleString("ja-JP") + ' 世帯<br>' +
      changePair.to + '年世帯数: ' + Math.round(toHouseholds).toLocaleString("ja-JP") + ' 世帯<br>' +
      '世帯増減: ' + signed(Math.round(diff), ' 世帯') + '<br>' +
      '人口増減: ' + signed(Math.round(populationChange(f)), ' 人') + '</div>';
  }

  if (mode === "households") {
    const households = featureHouseholds(f, currentYear);
    const pop = featurePopulation(f, currentYear);
    const peoplePerHousehold = households > 0 ? pop / households : 0;
    return '<div class="mesh-popup"><b>メッシュ ' + p.mesh_code + '</b><br>' +
      (p.is_hokuto ? '北杜市内' : '山梨県内') + '<br>' +
      currentYear + '年世帯数: ' + Math.round(households).toLocaleString("ja-JP") + ' 世帯<br>' +
      currentYear + '年人口: ' + Math.round(pop).toLocaleString("ja-JP") + ' 人<br>' +
      '1世帯あたり人口: ' + peoplePerHousehold.toFixed(2).toLocaleString("ja-JP") + ' 人/世帯<br>' +
      '2010→2020世帯増減: ' + signed(p.household_change_2010_2020 || 0, ' 世帯') + '</div>';
  }

  const rawPop = p.population[currentYear];
  const rawDensity = p.density_per_km2[currentYear];
  return '<div class="mesh-popup"><b>メッシュ ' + p.mesh_code + '</b><br>' +
    (p.is_hokuto ? '北杜市内' : '山梨県内') + '<br>' +
    currentYear + '年人口: ' + formatNullable(rawPop, value => Math.round(value).toLocaleString("ja-JP") + ' 人') + '<br>' +
    '人口密度: ' + formatNullable(rawDensity, value => Number(value).toLocaleString("ja-JP") + ' 人/km²') + '<br>' +
    '2010→2020増減: ' + (p.change_2010_2020 >= 0 ? '+' : '') + p.change_2010_2020.toLocaleString("ja-JP") + ' 人</div>';
}

function meshCenterLatLng(f) {
  const ring = f.geometry.coordinates[0];
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  return [
    (Math.min(...lats) + Math.max(...lats)) / 2,
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
  ];
}

function labelText(f) {
  if (mode === "density") {
    const rawValue = f.properties.density_per_km2[currentYear];
    if (rawValue === null || rawValue === undefined) return "--";
    const value = featureDensity(f, currentYear);
    return value >= 100 ? Math.round(value).toLocaleString("ja-JP") : value.toFixed(1);
  }
  if (mode === "households") {
    return Math.round(featureHouseholds(f, currentYear)).toLocaleString("ja-JP");
  }
  if (mode === "change") {
    return signed(Math.round(populationChange(f)), "");
  }
  if (mode === "householdChange") {
    return signed(Math.round(householdChange(f)), "");
  }
  const score = villaScore(f);
  if (score >= 999) return "∞";
  return score >= 100 ? Math.round(score).toLocaleString("ja-JP") : score.toFixed(1);
}

function styleForFeature(f) {
  const value = mode === "density" ? featureDensity(f, currentYear) : mode === "households" ? featureHouseholds(f, currentYear) : mode === "change" ? populationChange(f) : mode === "householdChange" ? householdChange(f) : villaScore(f);
  const dim = !inCurrentScope(f);
  const noVillaData = mode === "villa" && buildingProxy(f).total_buildings <= 0;
  return {
    color: "rgba(32,45,60,.45)",
    weight: dim || noVillaData ? 0.2 : 0.6,
    opacity: dim || noVillaData ? 0.18 : 0.85,
    fillColor: mode === "density" ? colorFor(value) : mode === "households" ? householdColorFor(value) : mode === "change" || mode === "householdChange" ? changeColorFor(value) : villaColorFor(value),
    fillOpacity: dim ? 0.08 : noVillaData ? 0.12 : 0.68,
  };
}

function renderMapLayer(features) {
  if (meshLayer) meshLayer.remove();
  if (boundaryLayer) boundaryLayer.remove();
  if (labelLayer) labelLayer.remove();

  meshLayer = L.geoJSON(geo, {
    style: styleForFeature,
    onEachFeature: (feature, layer) => {
      layer.bindPopup(() => popupHtml(feature), { closeButton: false, autoPanPadding: [20, 20] });
      layer.on("mouseover", () => layer.openPopup());
      layer.on("mouseout", () => layer.closePopup());
    },
  }).addTo(map);

  boundaryLayer = L.geoJSON(hokutoBoundary, {
    style: { color: "#111827", weight: 2, opacity: 0.9, fill: false },
    interactive: false,
  }).addTo(map);

  labelLayer = L.layerGroup();
  if (showLabels) {
    features.forEach((feature) => {
      const text = labelText(feature);
      L.marker(meshCenterLatLng(feature), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "mesh-label-icon",
          html: '<span class="mesh-label">' + text + '</span>',
          iconSize: [0, 0],
        }),
      }).addTo(labelLayer);
    });
  }
  labelLayer.addTo(map);

  const bounds = scope === "hokuto" ? boundaryLayer.getBounds() : geoJsonBounds(features);
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.05), { animate: false });
}

function render() {
  renderControls();
  document.getElementById("scopeYamanashi").classList.toggle("active", scope === "yamanashi");
  document.getElementById("scopeHokuto").classList.toggle("active", scope === "hokuto");
  document.getElementById("labelsOn").classList.toggle("active", showLabels);
  document.getElementById("labelsOff").classList.toggle("active", !showLabels);
  const features = selectedFeatures();
  renderStats(features);
  renderLegend();
  renderMapLayer(features);
}
render();
</script>
</body>
</html>`;
  fs.writeFileSync(path.join(OUTPUT, "mesh_map.html"), html);
  fs.writeFileSync(path.join(DIST, "index.html"), html);
}

const geojson = buildData();
buildHtml(geojson);

const summary = {
  features: geojson.features.length,
  hokutoFeatures: geojson.features.filter((f) => f.properties.is_hokuto).length,
  years: YEARS.map((y) => y.year),
};
console.log(JSON.stringify(summary, null, 2));
