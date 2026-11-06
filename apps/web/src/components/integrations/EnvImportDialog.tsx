/**
 * Import model keys from a .env file. The file is read in the browser; its text goes
 * to the local API once for a masked preview and once more for the keys the user ticks.
 */

import { useEffect, useRef, useState } from 'react';
import { api, type EnvImportPreview } from '../../lib/api';
import { Icon } from '../ui/Icon';
import { ImportReview } from './ImportReview';
import { KEY_META } from './KeysCategory';

export function EnvImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<EnvImportPreview>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const reset = () => {
    setText('');
    setPreview(undefined);
    setSelected(new Set());
    setError('');
  };
  const close = () => {
    reset();
    onClose();
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) {
      setError('That file is larger than 64 KB. Paste only the lines with keys.');
      return;
    }
    setText(await file.text());
  };

  const scan = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.previewEnvImport(text);
      setPreview(result);
      setSelected(new Set(result.matches.map((match) => match.providerId)));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The file could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.commitEnvImport(text, [...selected]);
      onImported(result.providers.length);
      close();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Nothing was imported. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      className="connection-dialog import-dialog"
      ref={dialog}
      onClose={close}
      aria-labelledby="env-import-title"
    >
      <div className="dialog-heading">
        <h2 id="env-import-title">Import keys from a .env file</h2>
        <button className="icon-button" aria-label="Close import" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {!preview ? (
        <>
          <p>
            Choose a file or paste its contents. Zephyr picks out the provider keys it knows and
            shows you the last four characters of each before saving anything.
          </p>
          <label className="secondary-button file-button">
            <Icon name="file" size={15} />
            Choose file
            <input
              type="file"
              accept=".env,text/plain"
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
          </label>
          <div className="field">
            <label htmlFor="env-import-text">File contents</label>
            <textarea
              id="env-import-text"
              rows={7}
              spellCheck={false}
              autoComplete="off"
              value={text}
              placeholder="ANTHROPIC_API_KEY=…"
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          {error && (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
          <div className="integration-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void scan()}
            >
              {busy ? 'Reading…' : 'Find keys'}
            </button>
          </div>
        </>
      ) : preview.matches.length === 0 ? (
        <>
          <p className="notice">
            No provider keys found. Zephyr looks for{' '}
            {Object.values(KEY_META)
              .map((meta) => meta.envVar)
              .join(', ')}
            .
          </p>
          <div className="integration-actions">
            <button className="secondary-button" type="button" onClick={reset}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <ImportReview
            items={preview.matches.map((match) => ({
              id: match.providerId,
              title: KEY_META[match.providerId]?.name ?? match.providerId,
              subtitle: match.envVar + ' ending in ' + match.last4,
              replaces: match.replaces,
            }))}
            selected={selected}
            onToggle={(id) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onConfirm={() => void commit()}
            onBack={reset}
            noun="key"
            busy={busy}
            footnote={
              preview.ignored > 0
                ? preview.ignored +
                  (preview.ignored === 1 ? ' other variable was' : ' other variables were') +
                  ' left out.'
                : undefined
            }
          />
          {error && (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </dialog>
  );
}
