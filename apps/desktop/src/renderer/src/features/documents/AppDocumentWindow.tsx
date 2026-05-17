import { useEffect, useState, type ReactElement } from "react";
import type { AppDocument, AppDocumentKind } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";

type Props = {
  kind: AppDocumentKind | null;
};

export function AppDocumentWindow({ kind }: Props): ReactElement {
  const [document, setDocument] = useState<AppDocument | null>(null);
  const [error, setError] = useState<string | null>(
    kind === null ? "Unknown app document." : null
  );

  useEffect(() => {
    if (kind === null) return;
    let cancelled = false;
    setDocument(null);
    setError(null);
    void (async () => {
      const result = await dispatch("app:readDocument", { kind });
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDocument(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const title =
    kind === "third-party-licenses" ? "Third-party Licenses" : "Changelog";

  return (
    <div className="ps-doc">
      <header className="ps-doc__titlebar">
        <div className="ps-doc__brand">
          <PwrSnapMark size={18} />
          <PwrSnapWordmark />
        </div>
        <div className="ps-doc__crumb">
          <span>Help</span>
          <span aria-hidden="true">/</span>
          <b>{document?.title ?? title}</b>
        </div>
      </header>
      <main className="ps-doc__main">
        {error !== null ? (
          <p className="ps-doc__error" role="alert">
            Could not load document: {error}
          </p>
        ) : document === null ? (
          <p className="ps-doc__empty">Loading...</p>
        ) : (
          <article className="ps-doc__body" aria-label={document.title}>
            <pre>{document.content}</pre>
          </article>
        )}
      </main>
    </div>
  );
}
