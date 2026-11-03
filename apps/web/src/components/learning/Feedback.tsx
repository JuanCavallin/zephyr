/**
 * The two explicit learning signals a person gives in the UI (docs/cacp-08-learning-loop.md):
 * thumbs on a finished result, and picking one of several variants. Both only record a
 * signal; nothing is learned until a learning pass reads it, and the server decides
 * privacy from the run or task, whatever the client says.
 */

import { useState } from 'react';
import { api } from '../../lib/api';
import { variantPickBody, type Variant } from '../../lib/learning';

type Origin = { taskId?: string; runId?: string; private?: boolean };

const failure = (issue: unknown) => (issue instanceof Error ? issue.message : 'Could not record that.');

export function Thumbs({ origin, label = 'Was this result right?' }: { origin: Origin; label?: string }) {
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  const [comment, setComment] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (rating: 'up' | 'down', note?: string) => {
    setBusy(true);
    setError('');
    try {
      await api.learningFeedback({ rating, ...(note?.trim() ? { comment: note.trim() } : {}), ...origin });
      setRated(rating);
      setAsking(false);
    } catch (issue) {
      setError(failure(issue));
    } finally {
      setBusy(false);
    }
  };

  if (rated) {
    return (
      <span className="learn-thumbs is-done" role="status">
        {rated === 'up' ? 'Thanks — noted.' : 'Noted. Zephyr will weigh this next pass.'}
      </span>
    );
  }

  return (
    <span className="learn-thumbs">
      <span className="learn-thumbs-label">{label}</span>
      <button className="secondary-button" disabled={busy} onClick={() => void send('up')}>
        Good
      </button>
      <button className="secondary-button" disabled={busy} onClick={() => setAsking(true)}>
        Not right
      </button>
      {asking && (
        <form
          className="learn-thumbs-why"
          onSubmit={(event) => {
            event.preventDefault();
            void send('down', comment);
          }}
        >
          <input
            aria-label="What was wrong (optional)"
            placeholder="What was wrong? (optional)"
            value={comment}
            maxLength={2000}
            onChange={(event) => setComment(event.target.value)}
            autoFocus
          />
          <button className="secondary-button" type="submit" disabled={busy}>
            Send
          </button>
        </form>
      )}
      {error && <span className="learn-error">{error}</span>}
    </span>
  );
}

/**
 * Pick one of several variants. Any surface that produces alternatives renders this; the
 * pick is recorded as a variant_pick signal with the others as rejected.
 */
export function VariantPicker({
  variants,
  origin = {},
  title = 'Which one fits better?',
  onPicked,
}: {
  variants: Variant[];
  origin?: Origin;
  title?: string;
  onPicked?: (variant: Variant) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (variant: Variant) => {
    const body = variantPickBody(variants, variant.id, origin);
    setPicked(variant.id);
    onPicked?.(variant);
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await api.learningVariantPick(body);
    } catch (issue) {
      setError(failure(issue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="learn-variants" aria-label={title}>
      <h4>{title}</h4>
      <div className="learn-variant-grid">
        {variants.map((v) => (
          <button
            key={v.id}
            className={'learn-variant' + (picked === v.id ? ' is-picked' : '')}
            disabled={busy || picked !== null}
            aria-pressed={picked === v.id}
            onClick={() => void pick(v)}
          >
            <strong>{v.label}</strong>
            {v.preview && <pre>{v.preview}</pre>}
          </button>
        ))}
      </div>
      {error && <span className="learn-error">{error}</span>}
    </section>
  );
}
