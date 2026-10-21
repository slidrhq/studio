import { useCallback, useEffect, useState } from 'react';
import { LANGUAGE_NAMES, type ContentLanguage } from '@slidr/model';
import {
  api,
  isTemplate,
  renderPicture,
  type LibraryState,
  type LibraryUpload,
  type Publication,
  type ServerStatus,
  type UploadItem,
  type Variant,
} from './api';
import { SlideView } from './SlideView';
import { useT } from './i18n';

/** Where an upload is seen up close, on the library's own page. */
const uploadUrl = (library: string, id: string) =>
  `${library.replace(/\/+$/, '')}/#lib=uploads&i=${encodeURIComponent(id)}`;

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

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

/** One upload of the library: what it is, in which languages, by whom, and what it wrote. */
function UploadRow({ upload, library }: { upload: LibraryUpload; library: string }) {
  const languages = upload.languages
    .map((lang) => LANGUAGE_NAMES[lang as ContentLanguage]?.native ?? lang)
    .join(', ');
  return (
    <li>
      <a href={uploadUrl(library, upload.id)} target="_blank" rel="noreferrer" dir="ltr">
        {upload.id}
      </a>{' '}
      <code dir="ltr">
        {upload.type}: {upload.action} {upload.target}
      </code>
      {languages && <span className="muted"> · {languages}</span>}
      {upload.by && (
        <span className="muted" dir="ltr">
          {' '}
          · {upload.by}
        </span>
      )}
      {upload.paths && upload.paths.length > 0 && (
        <span className="muted" dir="ltr">
          {' '}
          → {upload.paths.join(', ')}
        </span>
      )}
    </li>
  );
}

/**
 * Publishing. The approved work goes to the library's upload API (Slidr Library, README
 * "Uploading"), a design with its slides, names and search tags, a sample in its language; the
 * library checks each against what it publishes and keeps it until an editor accepts it. A
 * publication then writes the accepted uploads into the library, through its API too (README,
 * "Publishing the uploads"): the studio keeps no copy of the library, and writes none.
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
  const [state, setState] = useState<LibraryState>();
  const [accepted, setAccepted] = useState<LibraryUpload[]>();
  const [libraryError, setLibraryError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState<Publication>();
  const library = status?.library.url ?? '';
  const hasKey = status?.library.key ?? false;

  /** The library's state, and the uploads that wait for it. */
  const readLibrary = useCallback(() => {
    if (!hasKey) return;
    Promise.all([api.libraryState(), api.accepted()]).then(
      ([found, { uploads }]) => {
        setState(found);
        setAccepted(uploads);
        setLibraryError(undefined);
      },
      (failure: unknown) => setLibraryError(message(failure)),
    );
  }, [hasKey]);

  useEffect(readLibrary, [readLibrary]);

  const saveKey = () =>
    void api.librarySettings(key).then(
      () => {
        setKey('');
        setError(undefined);
        onStatus();
      },
      (failure: unknown) => setError(message(failure)),
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
        (failure: unknown) => setError(message(failure)),
      )
      .finally(() => {
        setBusy(false);
        readLibrary();
      });
  };

  const publish = () => {
    setPublishing(true);
    setDone(undefined);
    setLibraryError(undefined);
    api
      .publish()
      .then(setDone, (failure: unknown) => setLibraryError(message(failure)))
      .finally(() => {
        setPublishing(false);
        readLibrary();
      });
  };

  const waiting = accepted ?? [];

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
            disabled={busy || publishing}
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

          {hasKey && (
            <section>
              <h3>{t('publish.libraryTitle')}</h3>
              <p className="muted small">{t('publish.libraryNote')}</p>
              {state &&
                (state.live ? (
                  <p className="small">
                    {t('publish.liveState', {
                      at: state.published ? new Date(state.published).toLocaleString() : '',
                      files: state.files ?? 0,
                    })}
                  </p>
                ) : (
                  <p className="warn small">{t('publish.notLive')}</p>
                ))}
              <p className={waiting.length ? '' : 'muted'}>
                {accepted === undefined && !libraryError
                  ? '…'
                  : waiting.length
                    ? t('publish.acceptedCount', { count: waiting.length })
                    : t('publish.noAccepted')}{' '}
                <button type="button" className="ghost small" onClick={readLibrary}>
                  {t('publish.refresh')}
                </button>
              </p>
              {waiting.length > 0 && (
                <ul className="paths">
                  {waiting.map((upload) => (
                    <UploadRow key={upload.id} upload={upload} library={library} />
                  ))}
                </ul>
              )}
              {libraryError && <p className="error-text">{libraryError}</p>}
              <div className="form-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={publishing || waiting.length === 0 || state?.live === false}
                  onClick={publish}
                >
                  {t('publish.publishAccepted', { count: waiting.length })}
                </button>
              </div>
              {done && (
                <div className="report">
                  <p className="ok">
                    {done.published
                      ? t('publish.publishedResult', {
                          count: done.uploads.length,
                          at: new Date(done.published).toLocaleString(),
                        })
                      : t('publish.noAccepted')}
                  </p>
                  {done.uploads.length > 0 && (
                    <ul className="paths">
                      {done.uploads.map((upload) => (
                        <UploadRow key={upload.id} upload={upload} library={library} />
                      ))}
                    </ul>
                  )}
                  {done.skipped.length > 0 && (
                    <>
                      <p className="warn">
                        {t('publish.skippedResult', { count: done.skipped.length })}
                      </p>
                      <ul className="paths" dir="ltr">
                        {done.skipped.map((one) => (
                          <li key={one.id}>
                            <a href={uploadUrl(library, one.id)} target="_blank" rel="noreferrer">
                              {one.id}
                            </a>{' '}
                            {one.message}
                            {one.issues?.map((issue, i) => (
                              <div key={i} className="muted">
                                <code>{issue.path}</code> {issue.message}
                              </div>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
