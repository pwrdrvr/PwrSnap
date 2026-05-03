/* eslint-disable */
// PwrSnap shared primitives

const { useState: useStatePsPrim, useEffect: useEffectPsPrim, useRef: useRefPsPrim } = React;

function PsMark({ size = 16 }) {
  return (
    <svg viewBox="0 0 128 128" width={size} height={size} className="ps-mark" style={{ color: "var(--accent)" }}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M22 14H62a30 26 0 0 1 0 52H46v48H22Z M44 30L62 30L76 40L62 50L44 50Z M22 14H62a30 26 0 0 1 0 52H46v48H22Z M44 30L62 30L76 40L62 50L44 50Z"
      />
    </svg>
  );
}

function PsSnapMark({ size = 16 }) {
  return (
    <svg viewBox="0 0 128 128" width={size} height={size} className="ps-mark" style={{ color: "var(--accent)" }}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M22 14H62a30 26 0 0 1 0 52H46v48H22Z M44 30L52 30L52 34L48 34L48 38L44 38Z M64 30L72 30L72 38L68 38L68 34L64 34Z M44 42L48 42L48 46L52 46L52 50L44 50Z M64 50L64 46L68 46L68 42L72 42L72 50Z"
      />
    </svg>
  );
}

// Lucide icon helper. Renders an <i data-lucide=...> and triggers lucide.createIcons() on mount.
function PsIcon({ name, size = 16, color, style }) {
  const ref = useRefPsPrim(null);
  useEffectPsPrim(() => {
    if (window.lucide) {
      // create just for the parent so we don't repaint the world
      window.lucide.createIcons({ icons: window.lucide.icons, attrs: {} });
    }
  }, [name]);
  return (
    <i
      ref={ref}
      data-lucide={name}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: color || "currentColor",
        ...style,
      }}
    />
  );
}

function PsKbd({ children }) {
  return <span className="ps-kbd">{children}</span>;
}

function PsTag({ children, color = "default" }) {
  const cls = color === "default" ? "ps-tag" : `ps-tag is-${color}`;
  return <span className={cls}>{children}</span>;
}

window.PS = window.PS || {};
Object.assign(window.PS, { PsMark, PsSnapMark, PsIcon, PsKbd, PsTag });
