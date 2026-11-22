import sharp from "sharp";

export const initialFixtures = [
  {
    id: "release",
    panel: "Release Console",
    surface: "Release and promotion activity",
    source: { width: 2880, height: 1866, dpr: 2 },
    pointSize: { width: 1440, height: 933 },
    offset: [0, 0],
    status: "PROMOTION BLOCKED",
    facts: ["SIGNATURE MISMATCH", "key R7X-21", "digest C46F2A", "2 approvals missing"],
    section: "Promotion gate · current selection",
    light: false,
    arms: ["baseline", "points", "near-points", "large", "full"]
  },
  {
    id: "replica",
    panel: "Replication Desk",
    surface: "Replica activity and checkpoints",
    source: { width: 1351, height: 1801, dpr: 2 },
    pointSize: { width: 676, height: 901 },
    offset: [63, 17],
    status: "REPLAY PAUSED",
    facts: ["CHECKPOINT DIVERGED", "replica Q4-M7", "cursor 03DE19", "retry in 45 seconds"],
    section: "Replay exception · current selection",
    light: true,
    arms: ["baseline", "points", "full"]
  },
  {
    id: "retention",
    panel: "Retention Monitor",
    surface: "Retention policy verification",
    source: { width: 1900, height: 803, dpr: 1 },
    pointSize: { width: 1900, height: 803 },
    offset: [0, 0],
    status: "PURGE DEFERRED",
    facts: ["AUDIT HOLD ACTIVE", "case HN-512", "queue R08Q", "expires after 9 days"],
    section: "Purge exception · current selection",
    light: true,
    arms: ["baseline", "points", "full"]
  }
] as const;

export const balancedFixtures = [
  {
    id: "inventory",
    panel: "Inventory Console",
    surface: "Warehouse reconciliation",
    source: { width: 2400, height: 1600, dpr: 1 },
    pointSize: { width: 2400, height: 1600 },
    offset: [0, 0],
    status: "STOCKTAKE LOCKED",
    facts: ["COUNT VARIANCE OPEN", "aisle P4-A2", "ticket IV-603", "14 cartons unverified"],
    section: "Stocktake exception · current selection",
    light: false,
    arms: ["baseline", "balanced"]
  },
  {
    id: "routing",
    panel: "Routing Console",
    surface: "Dispatch and lane verification",
    source: { width: 5120, height: 2880, dpr: 2 },
    pointSize: { width: 2560, height: 1440 },
    offset: [0, 0],
    status: "DISPATCH HELD",
    facts: ["MANIFEST UNVERIFIED", "route R2-K8", "load L-517", "3 items unmatched"],
    section: "Dispatch exception · current selection",
    light: true,
    arms: ["baseline", "balanced"]
  }
] as const;

export const fixtures = [...initialFixtures, ...balancedFixtures] as const;
export type Fixture = (typeof fixtures)[number];
export type Arm = Fixture["arms"][number];

export async function renderFixture(fixture: Fixture, path: string): Promise<void> {
  const { width, height, dpr } = fixture.source;
  const { width: pointsWide, height: pointsHigh } = fixture.pointSize;
  const [cropX, cropY] = fixture.offset;
  const fill = fixture.light ? "#e8edf5" : "#101826";
  const panel = fixture.light ? "#ffffff" : "#172336";
  const ink = fixture.light ? "#182839" : "#dce7f4";
  const muted = fixture.light ? "#48586b" : "#a1b3c9";
  const alert = fixture.light ? "#a73319" : "#ffb17d";
  const contentWidth = pointsWide - 68;
  const alertY = pointsHigh - 201;
  const rows = Array.from({ length: Math.floor((alertY - 137) / 22) }, (_, i) => {
    const y = 141 + i * 22;
    const time = i + 10;
    const check = `${17 + Math.floor(time / 60)}:${String(time % 60).padStart(2, "0")}`;
    return `<rect x="28" y="${y - 12}" width="${contentWidth}" height="21" fill="${i % 2 ? panel : fill}"/>
      <text x="42" y="${y}">job-${400 + i} · batch ${String(i + 1).padStart(2, "0")}</text>
      <text x="${Math.round(pointsWide * 0.44)}" y="${y}">2026-05-12 ${check}:00</text>
      <text x="${pointsWide - 155}" y="${y}">${i % 3 ? "VERIFIED" : "STAGED"}</text>`;
  }).join("");
  // Rasterize at native density. For the region fixture extract at actual
  // pixel offsets, with an odd width and height, from a larger 2× desktop.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
    width="${(pointsWide + cropX) * dpr}" height="${(pointsHigh + cropY) * dpr}"
    viewBox="0 0 ${pointsWide + cropX} ${pointsHigh + cropY}">
    <rect width="100%" height="100%" fill="${fill}"/>
    <g transform="translate(${cropX} ${cropY})" font-family="Verdana" fill="${ink}">
      <rect x="14" y="13" width="${pointsWide - 28}" height="${pointsHigh - 26}" rx="8" fill="${panel}"/>
      <text x="31" y="49" font-size="25" font-weight="bold">${fixture.panel}</text>
      <text x="32" y="74" font-size="13" fill="${muted}">${fixture.surface}</text>
      <text x="42" y="115" font-size="11" fill="${muted}">RUN / BATCH</text>
      <text x="${Math.round(pointsWide * 0.44)}" y="115" font-size="11" fill="${muted}">LAST CHECK</text>
      <text x="${pointsWide - 155}" y="115" font-size="11" fill="${muted}">STATE</text>
      <g font-family="Andale Mono" font-size="11" fill="${muted}">${rows}</g>
      <rect x="28" y="${alertY}" width="${contentWidth}" height="161" rx="5" fill="${fill}"/>
      <text x="42" y="${alertY + 25}" font-size="14">${fixture.section}</text>
      <g font-family="Andale Mono" font-size="9" fill="${alert}">
        <text x="43" y="${alertY + 49}" font-weight="bold">state     ${fixture.status}</text>
        ${fixture.facts.map((fact, i) => `<text x="43" y="${alertY + 68 + i * 17}">${fact}</text>`).join("")}
      </g>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg))
    .extract({ left: cropX * dpr, top: cropY * dpr, width, height })
    .png()
    .toFile(path);
}
