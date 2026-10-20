import { useEffect, useRef, useState } from 'react';
import { LANGUAGE_NAMES } from '@slidr/model';
import {
  api,
  isTemplate,
  renderPicture,
  type PublishState,
  type ServerStatus,
  type Variant,
} from './api';
import { PUBLISH_PHASE, time } from './labels';
import { SlideView } from './SlideView';
import { useT } from './i18n';

function Paths({ title, paths, tone }: { title: string; paths: string[]; tone?: string }) {
  if (paths.length === 0) return null;
  return (
    <details open={paths.length <= 12} className={tone}>
      <summary>
        {title} ({paths.length})
      </summary>
      <ul className="paths" dir="ltr">
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Publishing: the approved designs, what sending them would change in the library, and the
 * confirmation. Nothing reaches Cloudflare before the person has read the report and confirmed.
 */
export function PublishPanel({
  publish,
  approved,
  status,
  onStatus,
  onClose,
}: {
  publish: PublishState;
  approved: Variant[];
  status?: ServerStatus;
  onStatus: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  const report = publish.report;
  const phase = publish.phase;
  const hasToken = status?.cloudflare.token ?? false;

  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [publish.log.length]);

  const run = (work: Promise<unknown>) =>
    work.then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );

  const saveToken = () =>
    void run(
      api.cloudflare(token, status?.cloudflare.accountId ?? '').then(() => {
        setToken('');
        onStatus();
      }),
    );

  const items = phase === 'idle' ? approved.map((variant) => variant.id) : publish.items;
  const busy = phase === 'preparing' || phase === 'publishing';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('publish.dialogLabel')}>
      <div className="drawer">
        <header className="detail-head">
          <div>
            <h2>{t('publish.title')}</h2>
            <p className="muted small" dir="ltr">
              {status?.media.url} · Cloudflare Pages slidr-media
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
              {items.length
                ? t('publish.itemsToPublish', { count: items.length })
                : t('publish.noApproved')}
            </h3>
            <div className="publish-items">
              {approved
                .filter((variant) => items.includes(variant.id))
                .map((variant) =>
                  isTemplate(variant) && variant.lang ? (
                    <figure key={variant.id}>
                      <img
                        className="slide-picture publish-thumb"
                        src={renderPicture(variant, 's01-thumb')}
                        alt=""
                        width={192}
                        height={108}
                      />
                      <figcaption>
                        {variant.brief.name.he} ·{' '}
                        <bdi lang={variant.lang}>{LANGUAGE_NAMES[variant.lang].native}</bdi>
                        <span className="muted" dir="ltr">
                          samples.{variant.templateId}.{variant.lang}
                        </span>
                      </figcaption>
                    </figure>
                  ) : (
                    <figure key={variant.id}>
                      <SlideView variant={variant} lang="he" width={192} />
                      <figcaption>
                        {variant.brief.name.he}
                        <span className="muted" dir="ltr">
                          {variant.designId}
                        </span>
                      </figcaption>
                    </figure>
                  ),
                )}
            </div>
            <p className="muted small">
              {t('publish.noteDesigns1')}
              <code>elements/designs/managed.json</code>
              {t('publish.noteDesigns2')}
              <code>m-</code>
              {t('publish.noteDesigns3')}
              <code>templates/catalog.json</code>
              {t('publish.noteDesigns4')}
              <code>pnpm media:publish</code>
              {t('publish.noteDesigns5')}
              <code dir="ltr">{status?.media.dir}</code>.
            </p>
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
                  placeholder="CLOUDFLARE_API_TOKEN"
                  dir="ltr"
                  autoComplete="off"
                />
                <button type="button" disabled={token.trim().length < 20} onClick={saveToken}>
                  {t('publish.save')}
                </button>
              </div>
            </section>
          )}

          <section>
            {PUBLISH_PHASE[phase] && (
              <p className={`phase phase-${phase}`}>{PUBLISH_PHASE[phase]}</p>
            )}
            {publish.error && <p className="error-text">{publish.error}</p>}
            {error && <p className="error-text">{error}</p>}

            {report && phase === 'prepared' && (
              <div className="report">
                <p>
                  {t('publish.reportSummary', {
                    before: report.before,
                    added: report.added.length,
                    changed: report.changed.length,
                    removed: report.removed.length,
                    files: report.files,
                    size: (report.bytes / 1024 / 1024).toFixed(1),
                  })}
                </p>
                {report.unexpected.length > 0 && (
                  <p className="warn">
                    {t('publish.unexpectedWarn', { count: report.unexpected.length })}
                  </p>
                )}
                {report.removed.length > 0 && (
                  <p className="warn">
                    {t('publish.removedWarn', { count: report.removed.length })}
                  </p>
                )}
                <Paths title={t('publish.pathsAdded')} paths={report.added} />
                <Paths title={t('publish.pathsChanged')} paths={report.changed} />
                <Paths title={t('publish.pathsRemoved')} paths={report.removed} tone="danger" />
              </div>
            )}

            <div className="form-actions">
              {(phase === 'idle' || phase === 'done' || phase === 'failed') && (
                <button
                  type="button"
                  className="primary"
                  disabled={approved.length === 0}
                  onClick={() => void run(api.prepare(approved.map((variant) => variant.id)))}
                >
                  {t('publish.prepare')}
                </button>
              )}
              {phase === 'prepared' && (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={!hasToken}
                    onClick={() => {
                      if (
                        window.confirm(t('publish.confirmSend', { count: publish.items.length }))
                      ) {
                        void run(api.confirm());
                      }
                    }}
                  >
                    {t('publish.approveSend')}
                  </button>
                  <button type="button" onClick={() => void run(api.cancelPublish())}>
                    {t('publish.cancel')}
                  </button>
                </>
              )}
            </div>
            {phase === 'prepared' && !hasToken && (
              <p className="warn small">{t('publish.needToken')}</p>
            )}
          </section>

          {publish.log.length > 0 && (
            <section className="log-box">
              <h3>{t('publish.log')}</h3>
              <ol className="log" dir="ltr" ref={list}>
                {publish.log.map((entry, i) => (
                  <li key={i}>
                    <span className="log-time">{time(entry.t)}</span>
                    <span className="log-text">{entry.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
