import { useState } from 'react';
import { LANGUAGE_NAMES } from '@slidr/model';
import {
  api,
  isTemplate,
  renderPicture,
  type ServerStatus,
  type UploadItem,
  type Variant,
} from './api';
import { SlideView } from './SlideView';
import { useT } from './i18n';

/** Where an upload is seen up close, on the library's own page. */
const uploadUrl = (library: string, id: string) =>
  `${library.replace(/\/+$/, '')}/#lib=uploads&i=${encodeURIComponent(id)}`;

/** What became of an item sent to the library: the upload it waits as, or what is wrong. */
function Outcome({ item, library }: { item: UploadItem; library: string }) {
  const t = useT();
  if (item.uploadId) {
    return (
      <p className="small ok">
        {t('publish.waiting')}{' '}
        <a href={uploadUrl(library, item.uploadId)} target="_blank" rel="noreferrer" dir="ltr">
          {item.uploadId}
        </a>
      </p>
    );
  }
  return (
    <div className="small">
      <p className="error-text">{t('publish.refused', { error: item.error ?? '' })}</p>
      {item.issues && item.issues.length > 0 && (
        <ul className="paths" dir="ltr">
          {item.issues.map((issue, i) => (
            <li key={i}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Publishing: the approved work goes to the library's upload API (Slidr Library, README
 * "Uploading"), a design with its slides, names and search tags, a sample in its language. The
 * library checks each against what it publishes and keeps it until an editor accepts it; it is
 * published from there. The studio never publishes the author copy itself.
 */
export function PublishPanel({
  approved,
  status,
  onStatus,
  onClose,
}: {
  approved: Variant[];
  status?: ServerStatus;
  onStatus: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Record<string, UploadItem>>({});
  const library = status?.library.url ?? '';
  const hasKey = status?.library.key ?? false;

  const saveKey = () =>
    void api.librarySettings(key).then(
      () => {
        setKey('');
        setError(undefined);
        onStatus();
      },
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );

  const send = () => {
    setBusy(true);
    setError(undefined);
    api
      .upload(approved.map((variant) => variant.id))
      .then(
        ({ items }) =>
          setSent((before) => ({
            ...before,
            ...Object.fromEntries(items.map((item) => [item.variantId, item])),
          })),
        (failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('publish.dialogLabel')}>
      <div className="drawer">
        <header className="detail-head">
          <div>
            <h2>{t('publish.title')}</h2>
            <p className="muted small" dir="ltr">
              {library}
            </p>
          </div>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label={t('publish.close')}
            disabled={busy}
          >
            ✕
          </button>
        </header>

        <div className="drawer-body">
          <section>
            <h3>
              {approved.length
                ? t('publish.itemsToPublish', { count: approved.length })
                : t('publish.noApproved')}
            </h3>
            <div className="publish-items">
              {approved.map((variant) => {
                const outcome = sent[variant.id];
                const earlier = !outcome && variant.upload;
                return (
                  <figure key={variant.id}>
                    {isTemplate(variant) && variant.lang ? (
                      <img
                        className="slide-picture publish-thumb"
                        src={renderPicture(variant, 's01-thumb')}
                        alt=""
                        width={192}
                        height={108}
                      />
                    ) : (
                      <SlideView variant={variant} lang="he" width={192} />
                    )}
                    <figcaption>
                      {variant.brief.name.he}
                      {isTemplate(variant) && variant.lang ? (
                        <>
                          {' · '}
                          <bdi lang={variant.lang}>{LANGUAGE_NAMES[variant.lang].native}</bdi>
                        </>
                      ) : null}
                      <span className="muted" dir="ltr">
                        {isTemplate(variant)
                          ? `${variant.templateId}.${variant.lang}`
                          : variant.designId}
                      </span>
                    </figcaption>
                    {outcome && <Outcome item={outcome} library={library} />}
                    {earlier && (
                      <Outcome
                        item={{ variantId: variant.id, uploadId: earlier.id }}
                        library={library}
                      />
                    )}
                  </figure>
                );
              })}
            </div>
            <p className="muted small">{t('publish.uploadNote')}</p>
          </section>

          {!hasKey && (
            <section className="token">
              <h3>{t('publish.keyTitle')}</h3>
              <p className="muted small">{t('publish.keyHelp')}</p>
              <div className="row">
                <input
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="SLIDR_LIBRARY_KEY"
                  dir="ltr"
                  autoComplete="off"
                />
                <button type="button" disabled={key.trim().length < 32} onClick={saveKey}>
                  {t('publish.save')}
                </button>
              </div>
            </section>
          )}

          <section>
            {error && <p className="error-text">{error}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="primary"
                disabled={approved.length === 0 || !hasKey || busy}
                onClick={send}
              >
                {t('publish.upload', { count: approved.length })}
              </button>
              {library && (
                <a
                  className="small"
                  href={`${library.replace(/\/+$/, '')}/#lib=uploads`}
                  target="slidr-library"
                  rel="noreferrer"
                >
                  {t('publish.openLibrary')}
                </a>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
