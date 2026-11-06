/**
 * The review step every import shares: one checkbox per found item, nothing stored
 * until the user confirms. Secrets arrive already masked by the server.
 */

export interface ImportReviewItem {
  id: string;
  title: string;
  subtitle: string;
  /** Set when importing would overwrite something already configured. */
  replaces?: boolean;
}

export function ImportReview({
  items,
  selected,
  onToggle,
  onConfirm,
  onBack,
  noun,
  busy,
  footnote,
}: {
  items: ImportReviewItem[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onBack: () => void;
  /** Singular noun for the confirm button, e.g. "key". */
  noun: string;
  busy?: boolean;
  footnote?: string;
}) {
  const count = items.filter((item) => selected.has(item.id)).length;
  return (
    <div className="import-review">
      <ul className="import-review-list">
        {items.map((item) => (
          <li key={item.id}>
            <label className="import-review-row">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => onToggle(item.id)}
              />
              <span className="import-review-text">
                <strong>{item.title}</strong>
                <span>{item.subtitle}</span>
              </span>
              {item.replaces && (
                <span className="status-chip status-chip--warn">Replaces saved</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      {footnote && <p className="inline-note">{footnote}</p>}
      <div className="integration-actions">
        <button className="secondary-button" type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={onConfirm}
          disabled={busy || count === 0}
        >
          {busy ? 'Importing…' : 'Import ' + count + ' ' + noun + (count === 1 ? '' : 's')}
        </button>
      </div>
    </div>
  );
}
