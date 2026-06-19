import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSubmit } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { mergeConfig, type StyleConfig } from "../styleConfig";

// ─── Loader ─────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const row = await db.styleSetting.findUnique({ where: { shop: session.shop } });
  let stored: unknown = null;
  if (row?.config) { try { stored = JSON.parse(row.config); } catch { stored = null; } }
  return { config: mergeConfig(stored) };
};

// ─── Action: save config ──────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const raw = form.get("config") as string;
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { return { error: "Invalid config" }; }
  const clean = mergeConfig(parsed); // normalise against schema before storing
  await db.styleSetting.upsert({
    where: { shop: session.shop },
    update: { config: JSON.stringify(clean) },
    create: { shop: session.shop, config: JSON.stringify(clean) },
  });
  return { ok: true };
};

type Device = "desktop" | "mobile";
type ElementKey = "section" | "card" | "title" | "price" | "button" | "badge";

// ─── Component ────────────────────────────────────────────────────────────────
export default function Customize() {
  const { config: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [config, setConfig] = useState<StyleConfig>(initial);
  const [device, setDevice] = useState<Device>("desktop");
  const [selected, setSelected] = useState<ElementKey>("section");

  // Immutable nested setter via path, e.g. set(["carousel","card","desktop","width"], 240)
  function set(path: (string | number)[], value: unknown) {
    setConfig((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      let obj: any = next;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  }

  function save() {
    const fd = new FormData();
    fd.set("config", JSON.stringify(config));
    submit(fd, { method: "post" });
  }

  const c = config.carousel;
  const dev = device;

  // Preview scaling so configured card dimensions fit the preview pane.
  const cardW = c.card[dev].width;
  const cardH = c.card[dev].height;
  const scale = Math.min(1, 165 / cardW);
  const pw = Math.round(cardW * scale);
  const ph = Math.round(cardH * scale);

  const selOutline = (key: ElementKey): React.CSSProperties =>
    selected === key ? { outline: "2px solid #008060", outlineOffset: "2px" } : {};

  return (
    <s-page heading="Customize Style">
      <s-button slot="primary-action" variant="primary" onClick={save} {...(saving ? { loading: "" } : {})}>
        {saving ? "Saving…" : "Save"}
      </s-button>

      <s-section>
        {/* Widget type tabs (only Carousel is functional in this phase) */}
        <div style={styles.tabs}>
          <button style={{ ...styles.tab, ...styles.tabActive }}>Carousel</button>
          {["Story", "Floating", "Overlay"].map((t) => (
            <button key={t} style={{ ...styles.tab, ...styles.tabDisabled }} disabled title="Coming soon">
              {t}
            </button>
          ))}
        </div>

        <div style={styles.layout}>
          {/* ── Preview ─────────────────────────────────────────── */}
          <div style={styles.previewCol}>
            <div style={styles.deviceToggle}>
              {(["desktop", "mobile"] as Device[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDevice(d)}
                  style={{ ...styles.deviceBtn, ...(device === d ? styles.deviceBtnActive : {}) }}
                >
                  {d === "desktop" ? "🖥 Desktop" : "📱 Mobile"}
                </button>
              ))}
            </div>

            <div style={{ ...styles.previewPane, maxWidth: dev === "mobile" ? 380 : "100%" }}>
              {/* Section title */}
              {c.section[dev].show && (
                <div
                  onClick={() => setSelected("section")}
                  style={{
                    cursor: "pointer",
                    fontWeight: c.section.fontWeight,
                    letterSpacing: c.section.letterSpacing,
                    fontSize: c.section[dev].fontSize * scale + 4,
                    color: c.section[dev].color,
                    textAlign: c.section[dev].align as any,
                    margin: `0 0 ${Math.round(c.section.marginBottom * scale)}px`,
                    ...selOutline("section"),
                  }}
                >
                  {c.section.text || "Section title"}
                </div>
              )}

              {/* Sample cards */}
              <div style={{ display: "flex", gap: c.card[dev].gap, overflowX: "auto", paddingBottom: 6 }}>
                {[0, 1].map((i) => (
                  <div key={i} style={{ flex: `0 0 ${pw}px` }}>
                    <div
                      onClick={() => setSelected("card")}
                      style={{
                        width: pw,
                        height: ph,
                        borderRadius: c.card[dev].radius,
                        background: "linear-gradient(160deg,#3a3f4b,#1c1f26)",
                        position: "relative",
                        overflow: "hidden",
                        cursor: "pointer",
                        border: c.card.borderWidth ? `${c.card.borderWidth}px solid ${c.card.borderColor}` : "none",
                        boxShadow: c.card.shadow ? "0 2px 12px rgba(0,0,0,0.18)" : "none",
                        ...selOutline("card"),
                      }}
                    >
                      {c.badge.showViews && (
                        <span
                          onClick={(e) => { e.stopPropagation(); setSelected("badge"); }}
                          style={{
                            position: "absolute", top: 6, left: 6,
                            background: "rgba(0,0,0,0.55)", color: c.badge.color,
                            fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 10,
                            ...selOutline("badge"),
                          }}
                        >
                          👁 118
                        </span>
                      )}
                      <span style={{ position: "absolute", bottom: 6, left: 8, color: "#fff", fontSize: 10, opacity: 0.7 }}>
                        video
                      </span>
                    </div>
                    <div style={{ padding: "6px 2px" }}>
                      {c.title[dev].show && (
                        <div
                          onClick={() => setSelected("title")}
                          style={{
                            cursor: "pointer",
                            fontSize: c.title[dev].fontSize * scale + 2,
                            color: c.title[dev].color,
                            fontWeight: c.title.fontWeight,
                            ...selOutline("title"),
                          }}
                        >
                          Product title
                        </div>
                      )}
                      {c.price[dev].show && (
                        <div
                          onClick={() => setSelected("price")}
                          style={{
                            cursor: "pointer",
                            fontSize: c.price[dev].fontSize * scale + 2,
                            color: c.price[dev].color,
                            fontWeight: c.price.fontWeight,
                            ...selOutline("price"),
                          }}
                        >
                          $10
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Sample CTA button (used inside the modal) */}
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={() => setSelected("button")}
                  style={{
                    background: c.button.bg,
                    color: c.button.textColor,
                    borderRadius: c.button.radius,
                    border: c.button.borderWidth ? `${c.button.borderWidth}px solid ${c.button.borderColor}` : "none",
                    padding: `${c.button.paddingY}px ${c.button.paddingX}px`,
                    fontWeight: c.button.fontWeight,
                    fontSize: c.button.fontSize,
                    cursor: "pointer",
                    ...selOutline("button"),
                  }}
                >
                  {c.button.text || "Add to cart"}
                </button>
              </div>
            </div>
          </div>

          {/* ── Settings panel ──────────────────────────────────── */}
          <div style={styles.settingsCol}>
            <div style={styles.settingsHeader}>{labels[selected]} settings</div>
            <div style={styles.settingsBody}>{renderSettings(selected, device, config, set)}</div>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

const labels: Record<ElementKey, string> = {
  section: "Section title",
  card: "Card / Video",
  title: "Product title",
  price: "Price",
  button: "Button",
  badge: "Views badge",
};

const WEIGHTS = ["400", "500", "600", "700", "800"];

// ─── Settings controls per element ───────────────────────────────────────────
function renderSettings(
  el: ElementKey,
  dev: Device,
  config: StyleConfig,
  set: (path: (string | number)[], value: unknown) => void,
) {
  const c = config.carousel;
  switch (el) {
    case "section":
      return (
        <>
          <Text label="Title text" value={c.section.text} onChange={(v) => set(["carousel", "section", "text"], v)} />
          <Toggle label={`Show on ${dev}`} value={c.section[dev].show} onChange={(v) => set(["carousel", "section", dev, "show"], v)} />
          <Num label="Font size (px)" value={c.section[dev].fontSize} onChange={(v) => set(["carousel", "section", dev, "fontSize"], v)} />
          <Weight value={c.section.fontWeight} onChange={(v) => set(["carousel", "section", "fontWeight"], v)} />
          <Num label="Letter spacing (px)" value={c.section.letterSpacing} onChange={(v) => set(["carousel", "section", "letterSpacing"], v)} />
          <Color label="Color" value={c.section[dev].color} onChange={(v) => set(["carousel", "section", dev, "color"], v)} />
          <Select label="Align" value={c.section[dev].align} options={["left", "center", "right"]} onChange={(v) => set(["carousel", "section", dev, "align"], v)} />
          <Num label="Space below (px)" value={c.section.marginBottom} onChange={(v) => set(["carousel", "section", "marginBottom"], v)} />
        </>
      );
    case "card":
      return (
        <>
          <Num label="Width (px)" value={c.card[dev].width} onChange={(v) => set(["carousel", "card", dev, "width"], v)} />
          <Num label="Height (px)" value={c.card[dev].height} onChange={(v) => set(["carousel", "card", dev, "height"], v)} />
          <Num label="Corner radius (px)" value={c.card[dev].radius} onChange={(v) => set(["carousel", "card", dev, "radius"], v)} />
          <Num label="Gap between cards (px)" value={c.card[dev].gap} onChange={(v) => set(["carousel", "card", dev, "gap"], v)} />
          <Num label="Border width (px)" value={c.card.borderWidth} onChange={(v) => set(["carousel", "card", "borderWidth"], v)} />
          <Color label="Border color" value={c.card.borderColor} onChange={(v) => set(["carousel", "card", "borderColor"], v)} />
          <Toggle label="Drop shadow" value={c.card.shadow} onChange={(v) => set(["carousel", "card", "shadow"], v)} />
        </>
      );
    case "title":
      return (
        <>
          <Toggle label={`Show on ${dev}`} value={c.title[dev].show} onChange={(v) => set(["carousel", "title", dev, "show"], v)} />
          <Num label="Font size (px)" value={c.title[dev].fontSize} onChange={(v) => set(["carousel", "title", dev, "fontSize"], v)} />
          <Weight value={c.title.fontWeight} onChange={(v) => set(["carousel", "title", "fontWeight"], v)} />
          <Color label="Color" value={c.title[dev].color} onChange={(v) => set(["carousel", "title", dev, "color"], v)} />
        </>
      );
    case "price":
      return (
        <>
          <Toggle label={`Show on ${dev}`} value={c.price[dev].show} onChange={(v) => set(["carousel", "price", dev, "show"], v)} />
          <Num label="Font size (px)" value={c.price[dev].fontSize} onChange={(v) => set(["carousel", "price", dev, "fontSize"], v)} />
          <Weight value={c.price.fontWeight} onChange={(v) => set(["carousel", "price", "fontWeight"], v)} />
          <Color label="Color" value={c.price[dev].color} onChange={(v) => set(["carousel", "price", dev, "color"], v)} />
        </>
      );
    case "button":
      return (
        <>
          <Text label="Button text" value={c.button.text} onChange={(v) => set(["carousel", "button", "text"], v)} />
          <Color label="Background" value={c.button.bg} onChange={(v) => set(["carousel", "button", "bg"], v)} />
          <Color label="Text color" value={c.button.textColor} onChange={(v) => set(["carousel", "button", "textColor"], v)} />
          <Num label="Font size (px)" value={c.button.fontSize} onChange={(v) => set(["carousel", "button", "fontSize"], v)} />
          <Weight value={c.button.fontWeight} onChange={(v) => set(["carousel", "button", "fontWeight"], v)} />
          <Num label="Corner radius (px)" value={c.button.radius} onChange={(v) => set(["carousel", "button", "radius"], v)} />
          <Num label="Padding vertical (px)" value={c.button.paddingY} onChange={(v) => set(["carousel", "button", "paddingY"], v)} />
          <Num label="Padding horizontal (px)" value={c.button.paddingX} onChange={(v) => set(["carousel", "button", "paddingX"], v)} />
          <Num label="Border width (px)" value={c.button.borderWidth} onChange={(v) => set(["carousel", "button", "borderWidth"], v)} />
          <Color label="Border color" value={c.button.borderColor} onChange={(v) => set(["carousel", "button", "borderColor"], v)} />
        </>
      );
    case "badge":
      return (
        <>
          <Toggle label="Show views badge" value={c.badge.showViews} onChange={(v) => set(["carousel", "badge", "showViews"], v)} />
          <Color label="Text color" value={c.badge.color} onChange={(v) => set(["carousel", "badge", "color"], v)} />
        </>
      );
  }
}

// ─── Small control components ─────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}
function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <Field label={label}><input type="text" value={value} onChange={(e) => onChange(e.target.value)} style={styles.input} /></Field>;
}
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <Field label={label}><input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} style={styles.input} /></Field>;
}
function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={styles.colorInput} />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...styles.input, width: 100 }} />
      </span>
    </Field>
  );
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ ...styles.field, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span style={styles.fieldLabel}>{label}</span>
    </label>
  );
}
function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={styles.input}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}
function Weight({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Field label="Font weight">
      <select value={String(value)} onChange={(e) => onChange(Number(e.target.value))} style={styles.input}>
        {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
    </Field>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  tabs: { display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid #e5e7eb", paddingBottom: 10 },
  tab: { padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  tabActive: { background: "#111", color: "#fff", borderColor: "#111" },
  tabDisabled: { opacity: 0.45, cursor: "not-allowed" },
  layout: { display: "flex", gap: 20, flexWrap: "wrap" },
  previewCol: { flex: "1 1 380px", minWidth: 320 },
  settingsCol: { flex: "0 0 300px", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", alignSelf: "flex-start" },
  deviceToggle: { display: "flex", gap: 6, marginBottom: 12 },
  deviceBtn: { padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13 },
  deviceBtnActive: { background: "#f0fdf4", borderColor: "#86efac", fontWeight: 600 },
  previewPane: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, background: "#fafafa", margin: "0 auto" },
  settingsHeader: { padding: "12px 14px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontWeight: 700, fontSize: 13 },
  settingsBody: { padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: "#374151" },
  input: { padding: "7px 9px", fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, outline: "none", boxSizing: "border-box", width: "100%" },
  colorInput: { width: 38, height: 32, padding: 0, border: "1px solid #d1d5db", borderRadius: 6, cursor: "pointer", background: "#fff" },
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
