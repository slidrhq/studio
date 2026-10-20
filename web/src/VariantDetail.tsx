import { LANGUAGE_NAMES, languagesOf } from '@slidr/model';
import { useEffect, useRef, useState } from 'react';
import { api, isRunning, languagesOfVariant, type Lang, type Variant } from './api';
import type { DesignResult } from './design';
import { LOG_KIND, money, time } from './labels';
import { useT } from './i18n';
import { LanguagePicker } from './languages';
import { StatusLine } from './RequestView';
import { SlideView, useResult } from './SlideView';

const THUMB = 384;
const nameOf = (lang: Lang) => LANGUAGE_NAMES[lang].native;

function Findings({ result }: { result: DesignResult }) {
  const t = useT();
  const rows: { lang: string; kind: string; text: string; severe: boolean }[] = [];
  const langs = languagesOf(result.langs);
  for (const issue of result.issues)
    rows.push({
      lang: langs.length === 2 ? t('variant.langBoth') : t('variant.langAll'),
      kind: t('variant.kindContract'),
      text: issue,
      severe: true,
    });
  for (const lang of langs) {
    const side = result.langs[lang];
    if (!side) continue;
    const name = nameOf(lang);
    if (side.error)
      rows.push({ lang: name, kind: t('variant.kindConversion'), text: side.error, severe: true });
    for (const issue of side.issues)
      rows.push({ lang: name, kind: t('variant.kindContract'), text: issue, severe: true });
    for (const finding of side.findings) {
      rows.push({
        lang: name,
        kind: t(finding.severity === 'error' ? 'variant.kindError' : 'variant.kindWarning', {
          rule: finding.rule,
        }),
        text: finding.message,
        severe: finding.severity === 'error',
      });
    }
  }
  if (rows.length === 0) {
    return <p className="ok">{t('variant.findingsNone')}</p>;
  }
  return (
    <ul className="findings">
      {rows.map((row, i) => (
        <li key={i} className={row.severe ? 'severe' : ''}>
          <span className="tag" dir="auto">
            {row.lang}
          </span>
          <span className="tag">{row.kind}</span>
          <span dir="auto">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Log({ variant }: { variant: Variant }) {
  const list = useRef<HTMLOListElement>(null);
  // The list follows its newest line; the panel around it stays where the person left it.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [variant.log.length]);
  return (
    <ol className="log" ref={list}>
      {variant.log.map((entry, i) => (
        <li key={i} className={`log-${entry.kind}`}>
          <span className="log-time">{time(entry.t)}</span>
          <span className="tag">{LOG_KIND[entry.kind] ?? entry.kind}</span>
          <span dir="auto" className="log-text">
            {entry.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One variant, up close: every language at full size and as the gallery's thumbnail. */
export function VariantDetail({
  variant,
  lang: initial,
  onClose,
}: {
  variant: Variant;
  lang: Lang;
  onClose: () => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  const [feedback, setFeedback] = useState('');
  const [imageNote, setImageNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const result = useResult(variant);
  const running = isRunning(variant);
  const render = variant.render;
  const langs = languagesOfVariant(variant, result);
  // A language the variant was not made in, chosen for the whole studio, shows its English.
  const shown = langs.includes(lang) ? lang : 'en';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      after?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (render && render.errors > 0) {
      const sure = window.confirm(t('variant.confirmApproveWithErrors', { count: render.errors }));
      if (!sure) return;
    }
    void run(() => api.approve(variant.id, true));
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={variant.brief.name.he}>
      <div className="detail">
        <header className="detail-head">
          <div>
            <h2>
              {variant.brief.name.he} <span className="muted">·</span>{' '}
              <span className="muted" dir="ltr">
                {variant.brief.name.en}
              </span>
            </h2>
            <p className="muted small" dir="ltr">
              {variant.designId} · {variant.brief.group}
              {render && ` · revision ${render.revision}`}
              {variant.cost > 0 && ` · ${money(variant.cost)}`}
            </p>
          </div>
          <div className="actions">
            <LanguagePicker langs={langs} lang={shown} onChange={setLang} />
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              aria-label={t('variant.close')}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="detail-body">
          <div className="stage">
            {render ? (
              <>
                <SlideView variant={variant} lang={shown} result={result} />
                <h3>{t('variant.galleryPreview')}</h3>
                <div className="thumbs">
                  {langs.map((side) => (
                    <figure key={side}>
                      <SlideView variant={variant} lang={side} width={THUMB} result={result} />
                      <figcaption lang={side} dir="auto">
                        {nameOf(side)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <p className="muted small">
                  {t('variant.conversion')}{' '}
                  {langs.map((side, i) => (
                    <span key={side}>
                      {i > 0 && ' · '}
                      <bdi lang={side}>{nameOf(side)}</bdi>{' '}
                      {t('variant.editablePercent', {
                        percent: Math.round((render.editability[side] ?? 0) * 100),
                      })}
                    </span>
                  ))}
                  {t('variant.renderNote')}
                </p>
              </>
            ) : (
              <div className="slide-empty working big">
                <StatusLine variant={variant} />
              </div>
            )}
          </div>

          <aside className="side">
            <section>
              <div className="row">
                <StatusLine variant={variant} />
                {running && (
                  <button type="button" onClick={() => void run(() => api.cancel(variant.id))}>
                    {t('variant.stop')}
                  </button>
                )}
                {(variant.status === 'failed' || variant.status === 'cancelled') && (
                  <button type="button" onClick={() => void run(() => api.retry(variant.id))}>
                    {t('variant.retry')}
                  </button>
                )}
              </div>
              {variant.error && <p className="error-text">{variant.error}</p>}
              {error && <p className="error-text">{error}</p>}
            </section>

            <section className="approve-box">
              {variant.approved ? (
                <>
                  <p className="ok">{t('variant.approvedNote')}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.approve(variant.id, false))}
                  >
                    {t('variant.unapprove')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || running || variant.status !== 'ready' || !render?.publishable}
                    onClick={approve}
                  >
                    {t('variant.approve')}
                  </button>
                  {render && !render.publishable && (
                    <p className="warn small">{t('variant.notPublishable')}</p>
                  )}
                </>
              )}
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void run(() => api.discard(variant.id, !variant.discarded), onClose)}
              >
                {variant.discarded ? t('variant.restore') : t('variant.discard')}
              </button>
            </section>

            <section>
              <h3>{t('variant.findings')}</h3>
              {result ? (
                <Findings result={result} />
              ) : (
                <p className="muted">{t('variant.noRender')}</p>
              )}
            </section>

            <section>
              <h3>{t('variant.changeRequest')}</h3>
              <textarea
                rows={3}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t('variant.feedbackPlaceholder')}
              />
              <button
                type="button"
                disabled={busy || running || feedback.trim().length < 2}
                onClick={() =>
                  void run(
                    () => api.refine(variant.id, feedback.trim()),
                    () => setFeedback(''),
                  )
                }
              >
                {t('variant.sendToClaude')}
              </button>
            </section>

            <section>
              <h3>{t('variant.image')}</h3>
              {variant.image && (
                <details className="small">
                  <summary className="muted">
                    {variant.image.width}×{variant.image.height} · {t('variant.imagePromptSummary')}
                  </summary>
                  <p className="muted" dir="ltr">
                    {variant.image.prompt}
                  </p>
                </details>
              )}
              <input
                value={imageNote}
                onChange={(event) => setImageNote(event.target.value)}
                placeholder={t('variant.imageNotePlaceholder')}
              />
              <button
                type="button"
                disabled={busy || running}
                onClick={() =>
                  void run(
                    () => api.newImage(variant.id, imageNote.trim()),
                    () => setImageNote(''),
                  )
                }
              >
                {imageNote.trim() ? t('variant.changeImage') : t('variant.newImage')}
              </button>
            </section>

            <details>
              <summary>{t('variant.concept')}</summary>
              <p dir="auto">{variant.brief.concept}</p>
              <p dir="auto" className="muted small">
                {variant.brief.art}
              </p>
            </details>

            <section className="log-box">
              <h3>{t('variant.log')}</h3>
              <Log variant={variant} />
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
