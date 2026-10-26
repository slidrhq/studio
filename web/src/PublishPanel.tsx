import { useEffect, useState } from 'react';
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
import { useT, type MessageKey } from './i18n';

/** Where an upload is seen up close, on the library's own page. */
const uploadUrl = (library: string, id: string) =>
  `${library.replace(/\/+$/, '')}/#lib=uploads&i=${encodeURIComponent(id)}`;

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

const STATUS: Record<string, MessageKey> = {
  pending: 'publish.statusPending',
  accepted: 'publish.statusAccepted',
  rejected: 'publish.statusRejected',
  published: 'publish.statusPublished',
};

/** Where an item stands in the library: its upload's status and why it waits, or what is wrong. */
function Outcome({ item, library }: { item: UploadItem; library: string }) {
  const t = useT();
  if (item.uploadId && item.status) {
    const key = STATUS[item.status];
    return (
      <div className="small">
        <a
          className={item.status === 'published' ? 'ok' : item.status === 'rejected' ? 'warn' : ''}
          href={uploadUrl(library, item.uploadId)}
          target="_blank"
          rel="noreferrer"
        >
          {key ? t(key) : item.status}
        </a>
        {item.note && <p className="muted">{item.note}</p>}
      </div>
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
 * Publishing. The approved work goes to the library's upload API (Slidr Library, README
 * "Uploading"), a design with its slides, names and search tags, a sample in its language. With the
 * studio's token, which publishes, the library publishes each at once, or keeps it and says why:
 * that is the library's business, and the panel only shows where each upload stands.
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
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Record<string, UploadItem>>({});
  // What was approved when the panel opened: a published variant leaves the queue, and stays here.
  const [shown] = useState(approved);
  const library = status?.library.url ?? '';
  const hasToken = status?.library.token ?? false;

  const keep = (found: UploadItem[]) =>
    setItems((before) => ({
      ...before,
      ...Object.fromEntries(found.map((item) => [item.variantId, item])),
    }));

  /** Where the uploads sent before stand in the library now. */
  useEffect(() => {
    const sent = shown.filter((variant) => variant.upload).map((variant) => variant.id);
    if (!hasToken || sent.length === 0) return;
    api.statuses(sent).then(
      ({ items: found }) => keep(found),
      (failure: unknown) => setError(message(failure)),
    );
  }, [hasToken, shown]);

  const saveToken = () =>
    void api.librarySettings(token).then(
      () => {
        setToken('');
        setError(undefined);
        onStatus();
      },
      (failure: unknown) => setError(message(failure)),
    );

  const pending = approved.filter((variant) => items[variant.id]?.status !== 'published');

  const send = () => {
    setBusy(true);
    setError(undefined);
    api
      .upload(pending.map((variant) => variant.id))
      .then(
        ({ items: found }) => keep(found),
        (failure: unknown) => setError(message(failure)),
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
              {shown.length
                ? t('publish.itemsToPublish', { count: shown.length })
                : t('publish.noApproved')}
            </h3>
            <div className="publish-items">
              {shown.map((variant) => {
                const outcome =
                  items[variant.id] ??
                  (variant.upload
                    ? {
                        variantId: variant.id,
                        uploadId: variant.upload.id,
                        status: variant.upload.status,
                      }
                    : undefined);
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
                  </figure>
                );
              })}
            </div>
          </section>

          {!hasToken && (
            <section className="token">
              <h3>{t('publish.tokenTitle')}</h3>
              <p className="muted small">{t('publish.tokenHelp')}</p>
              <div className="row">
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="slk_…"
                  dir="ltr"
                  autoComplete="off"
                />
                <button
                  type="button"
                  disabled={!/^slk_[A-Za-z0-9_-]{43}$/.test(token.trim())}
                  onClick={saveToken}
                >
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
                disabled={pending.length === 0 || !hasToken || busy}
                onClick={send}
              >
                {t('publish.upload', { count: pending.length })}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
