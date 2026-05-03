import type { ReactNode } from "react";

export function Kbd({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return <span className={"ps-kbd" + (accent ? " is-accent" : "")}>{children}</span>;
}

export function PsSnapMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      style={{ color: "var(--accent)", display: "block" }}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M22 14H62a30 26 0 0 1 0 52H46v48H22Z M44 30L52 30L52 34L48 34L48 38L44 38Z M64 30L72 30L72 38L68 38L68 34L64 34Z M44 42L48 42L48 46L52 46L52 50L44 50Z M64 50L64 46L68 46L68 42L72 42L72 50Z"
      />
    </svg>
  );
}
