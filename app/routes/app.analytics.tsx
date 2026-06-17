import { useState } from "react";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

// ─── Loader ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") ?? "7", 10);

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  // Fetch all events in range
  const events = await db.analyticsEvent.findMany({
    where: { shop: session.shop, createdAt: { gte: since } },
    select: { type: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Totals
  const totalViews = events.filter((e) => e.type === "VIEW").length;
  const totalATC   = events.filter((e) => e.type === "ATC").length;

  // Build daily buckets
  const buckets: Record<string, { date: string; views: number; atc: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    buckets[key] = { date: key, views: 0, atc: 0 };
  }

  for (const event of events) {
    const key = new Date(event.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (buckets[key]) {
      if (event.type === "VIEW") buckets[key].views++;
      if (event.type === "ATC")  buckets[key].atc++;
    }
  }

  const trend = Object.values(buckets);

  return { days, totalViews, totalATC, trend };
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { days, totalViews, totalATC, trend } = useLoaderData<typeof loader>();

  const ranges = [
    { label: "Past 7 days",  value: 7 },
    { label: "Past 30 days", value: 30 },
    { label: "Past 90 days", value: 90 },
  ];

  return (
    <s-page heading="Analytics">
      {/* Date range selector */}
      <div style={s.toolbar}>
        <span style={s.rangeLabel}>Select date range</span>
        <div style={s.rangePills}>
          {ranges.map((r) => (
            <Link
              key={r.value}
              to={`?days=${r.value}`}
              style={{ ...s.pill, ...(days === r.value ? s.pillActive : {}) }}
            >
              {r.label}
            </Link>
          ))}
        </div>
      </div>

      {/* ── Conversions ─────────────────────────────────────────── */}
      <s-section>
        <div style={s.sectionHeader}>
          <span style={s.sectionTitle}>Conversions</span>
          <span style={s.sectionSub}>Last {days} Days</span>
        </div>
        <div style={s.statGrid}>
          <StatCard icon="👤" label="Video viewers" value={totalViews.toLocaleString()} />
          <StatCard icon="🛒" label="Video ATC"     value={totalATC.toLocaleString()} />
          <StatCard icon="📦" label="Video orders"  value="—" note="Coming soon" />
          <StatCard icon="💰" label="Video revenue" value="—" note="Coming soon" />
        </div>
      </s-section>

      {/* ── Engagement ──────────────────────────────────────────── */}
      <s-section>
        <div style={s.sectionHeader}>
          <span style={s.sectionTitle}>Engagement</span>
          <span style={s.sectionSub}>Last {days} Days</span>
        </div>
        <div style={s.statGridThree}>
          <StatCard icon="🕐" label="Total Views"    value={totalViews.toLocaleString()} />
          <StatCard icon="🕐" label="Avg Watch Time" value="—" note="Coming soon" />
          <StatCard icon="🕐" label="Total Watch Time" value="—" note="Coming soon" />
        </div>
      </s-section>

      {/* ── Trends ──────────────────────────────────────────────── */}
      <s-section>
        <div style={s.sectionHeader}>
          <span style={s.sectionTitle}>Trends</span>
        </div>
        <div style={s.chartGrid}>
          <ChartCard title="Video viewers" days={days} dataKey="views" data={trend} color="#2563eb" />
          <ChartCard title="Video ATC"     days={days} dataKey="atc"   data={trend} color="#2563eb" />
        </div>
      </s-section>
    </s-page>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatCard({ icon, label, value, note }: { icon: string; label: string; value: string; note?: string }) {
  return (
    <div style={s.statCard}>
      <div style={s.statIcon}>{icon}</div>
      <div>
        <p style={s.statLabel}>{label}</p>
        <p style={s.statValue}>{value}</p>
        {note && <p style={s.statNote}>{note}</p>}
      </div>
    </div>
  );
}

function ChartCard({
  title, days, dataKey, data,
}: {
  title: string;
  days: number;
  dataKey: "views" | "atc";
  data: { date: string; views: number; atc: number }[];
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

  const W = 500, H = 180, padL = 36, padR = 12, padT = 10, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = data.map((d) => d[dataKey]);
  const maxVal = Math.max(...values, 1);

  const px = (i: number) => padL + (i / Math.max(data.length - 1, 1)) * innerW;
  const py = (v: number) => padT + innerH - (v / maxVal) * innerH;

  const points = data.map((d, i) => `${px(i)},${py(d[dataKey])}`).join(" ");

  // Y-axis ticks: 0, half, max
  const yTicks = [0, Math.round(maxVal / 2), maxVal];

  // X-axis: show every Nth label to avoid crowding
  const xStep = days <= 7 ? 1 : days <= 30 ? 4 : 14;

  return (
    <div style={s.chartCard}>
      <p style={s.chartTitle}>{title} <span style={s.chartSub}>(Last {days} Days)</span></p>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {/* Grid lines */}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={py(v)} y2={py(v)} stroke="#f0f0f0" strokeWidth="1" />
              <text x={padL - 4} y={py(v) + 4} textAnchor="end" fontSize="10" fill="#9ca3af">{v}</text>
            </g>
          ))}

          {/* X labels */}
          {data.map((d, i) =>
            i % xStep === 0 ? (
              <text key={i} x={px(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="#9ca3af">
                {d.date}
              </text>
            ) : null
          )}

          {/* Line */}
          <polyline
            points={points}
            fill="none"
            stroke="#2563eb"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Dots + hover targets */}
          {data.map((d, i) => (
            <g key={i}>
              <circle cx={px(i)} cy={py(d[dataKey])} r="3" fill="#2563eb" />
              <circle
                cx={px(i)} cy={py(d[dataKey])} r="10" fill="transparent"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setTooltip({ x: px(i), y: py(d[dataKey]), label: d.date, value: d[dataKey] })}
                onMouseLeave={() => setTooltip(null)}
              />
            </g>
          ))}

          {/* Tooltip */}
          {tooltip && (
            <g>
              <rect
                x={tooltip.x - 30} y={tooltip.y - 36}
                width="60" height="24" rx="5"
                fill="#111827"
              />
              <text x={tooltip.x} y={tooltip.y - 20} textAnchor="middle" fontSize="11" fill="white" fontWeight="600">
                {tooltip.value}
              </text>
              <text x={tooltip.x} y={tooltip.y - 10} textAnchor="middle" fontSize="9" fill="#9ca3af">
                {tooltip.label}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "14px 20px",
    marginBottom: "16px",
    flexWrap: "wrap",
    gap: "10px",
  },
  rangeLabel: { fontSize: "14px", color: "#374151", fontWeight: 500 },
  rangePills: { display: "flex", gap: "8px" },
  pill: {
    padding: "6px 14px",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: 500,
    color: "#6b7280",
    textDecoration: "none",
    background: "#f3f4f6",
    border: "1px solid transparent",
  },
  pillActive: { background: "#111827", color: "#fff" },

  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "14px",
  },
  sectionTitle: { fontSize: "15px", fontWeight: 700, color: "#111827" },
  sectionSub:   { fontSize: "12px", color: "#9ca3af" },

  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "12px",
  },
  statGridThree: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "12px",
  },
  statCard: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "16px 18px",
  },
  statIcon:  { fontSize: "22px", flexShrink: 0, background: "#f3f4f6", borderRadius: "50%", width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center" },
  statLabel: { fontSize: "12px", color: "#6b7280", margin: "0 0 2px" },
  statValue: { fontSize: "22px", fontWeight: 700, color: "#111827", margin: 0 },
  statNote:  { fontSize: "11px", color: "#d1d5db", margin: "2px 0 0" },

  chartGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
    gap: "16px",
  },
  chartCard: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "18px 20px",
  },
  chartHeader: { marginBottom: "12px" },
  chartTitle:  { fontSize: "14px", fontWeight: 700, color: "#111827" },
  chartSub:    { fontSize: "12px", fontWeight: 400, color: "#9ca3af" },
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
