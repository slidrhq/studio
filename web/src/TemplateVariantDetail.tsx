import { LANGUAGE_NAMES, languageDir } from '@slidr/model';
import { useEffect, useState } from 'react';
import { api, isRunning, renderPicture, templateResult, type Lang, type Variant } from './api';
import { money } from './labels';
import { useT } from './i18n';
import { StatusLine } from './RequestView';
import type { SlideResult, TemplateResult } from './template';
import { Log } from './VariantDetail';

const slideName = (index: number) => `s${String(index + 1).padStart(2, '0')}`;

/** The findings of a template variant's latest render. */
function useTemplateResult(variant: Variant): TemplateResult | undefined {
  const revision = variant.render?.revision;
  const key = `${variant.id}:${revision}`;
  const [result, setResult] = useState<{ key: string; value: TemplateResult }>();
  useEffect(() => {
    if (!revision) return;
    let live = true;
    templateResult(variant.id, revision).then(
      (value) => live && setResult({ key, value }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [variant.id, revision, key]);
  return result?.key === key ? result.value : undefined;
}

/** How many findings of a slide are this language's own, and whether one is an error. */
function counts(slide: SlideResult | undefined) {
  const own = slide?.findings.filter((finding) => !finding.baseline) ?? [];
  const severe =
    Boolean(slide?.error) ||
    (slide?.issues.length ?? 0) > 0 ||
    own.some((finding) => finding.severity === 'error');
  return { own: own.length + (slide?.issues.length ?? 0) + (slide?.error ? 1 : 0), severe };
}

function SlideFindings({ slide }: { slide: SlideResult }) {
  const t = useT();
  const own = slide.findings.filter((finding) => !finding.baseline);
  const inherited = slide.findings.filter((finding) => finding.baseline);
  const rows = [
    ...(slide.error
      ? [{ kind: t('templateVariant.kindBuild'), text: slide.error, severe: true }]
      : []),
    ...slide.issues.map((text) => ({
      kind: t('templateVariant.kindContract'),
      text,
      severe: true,
    })),
    ...own.map((finding) => ({
      kind: t(
        finding.severity === 'error' ? 'templateVariant.kindError' : 'templateVariant.kindWarning',
        { rule: finding.rule },
      ),
      text: finding.message,
      severe: finding.severity === 'error',
    })),
  ];
  return (
    <>
      {rows.length === 0 ? (
        <p className="ok small">{t('templateVariant.noFindings')}</p>
      ) : (
        <ul className="findings">
          {rows.map((row, i) => (
            <li key={i} className={row.severe ? 'severe' : ''}>
              <span className="tag">{row.kind}</span>
              <span dir="auto">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {inherited.length > 0 && (
        <details className="small">
          <summary className="muted">
            {t('templateVariant.inheritedFindings', { count: inherited.length })}
          </summary>
          <ul className="findings">
            {inherited.map((finding, i) => (
              <li key={i}>
                <span className="tag">{finding.rule}</span>
                <span dir="auto">{finding.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * A template's sample in one language, up close: each slide at full size, all of them as the
 * template library shows them, and the findings slide by slide.
 */
export function TemplateVariantDetail({
  variant,
  onClose,
}: {
  variant: Variant;
  onClose: () => void;
}) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const result = useTemplateResult(variant);
  const running = isRunning(variant);
  const render = variant.render;
  const lang: Lang = variant.lang ?? 'en';
  const slides = result?.slides ?? [];
  const at = Math.min(index, Math.max(0, slides.length - 1));
  const slide = slides[at];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.target instanceof HTMLTextAreaElement) return;
      // The arrows step through the slides in the direction they read.
      const forward = languageDir(lang) === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      if (event.key === forward) setIndex((i) => Math.min(i + 1, Math.max(0, slides.length - 1)));
      if (event.key === back) setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, lang, slides.length]);

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
      const sure = window.confirm(t('templateVariant.confirmApprove', { count: render.errors }));
      if (!sure) return;
    }
    void run(() => api.approve(variant.id, true));
  };

  const title = `${variant.brief.name.he} · ${LANGUAGE_NAMES[lang].native}`;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="detail">
        <header className="detail-head">
          <div>
            <h2>
              {variant.brief.name.he} <span className="muted">·</span>{' '}
              <bdi lang={lang}>{LANGUAGE_NAMES[lang].native}</bdi>
            </h2>
            <p className="muted small" dir="ltr">
              templates/catalog.json · samples.{variant.templateId}.{lang}
              {variant.brief.rewrite && ' (rewrite)'}
              {render && ` · revision ${render.revision}`}
              {variant.cost > 0 && ` · ${money(variant.cost)}`}
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              aria-label={t('templateVariant.close')}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="detail-body">
          <div className="stage">
            {render && slides.length > 0 ? (
              <>
                {slide && (
                  <figure className="sample-slide">
                    {slide.error ? (
                      <div className="slide-empty big">
                        <p className="error-text" dir="auto">
                          {t('templateVariant.slideNotBuilt', { error: slide.error })}
                        </p>
                      </div>
                    ) : (
                      <img
                        className="slide-picture"
                        src={renderPicture(variant, `${slideName(at)}-full`)}
                        alt={slide.name}
                      />
                    )}
                    <figcaption dir="auto">
                      {at + 1} / {slides.length} · {slide.name} ·{' '}
                      <bdi dir="ltr">{slide.layout}</bdi>
                    </figcaption>
                  </figure>
                )}
                <h3>{t('templateVariant.allSlides')}</h3>
                <div className="sample-sheet" dir={languageDir(lang)}>
                  {slides.map((one) => {
                    const { own, severe } = counts(one);
                    return (
                      <button
                        type="button"
                        key={one.index}
                        className={`sample-thumb${one.index === at ? ' current' : ''}`}
                        onClick={() => setIndex(one.index)}
                        aria-label={`${one.index + 1}: ${one.name}`}
                      >
                        {one.error ? (
                          <div className="slide-empty" />
                        ) : (
                          <img
                            className="slide-picture"
                            src={renderPicture(variant, `${slideName(one.index)}-thumb`)}
                            alt=""
                            loading="lazy"
                          />
                        )}
                        <span className="sample-thumb-label" dir="auto">
                          {one.index + 1}. {one.name}
                          {own > 0 && <span className={severe ? 'warn' : 'muted'}> · {own}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="muted small">{t('templateVariant.sheetNote')}</p>
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
                    {t('templateVariant.stop')}
                  </button>
                )}
                {(variant.status === 'failed' || variant.status === 'cancelled') && (
                  <button type="button" onClick={() => void run(() => api.retry(variant.id))}>
                    {t('templateVariant.retry')}
                  </button>
                )}
              </div>
              {variant.error && <p className="error-text">{variant.error}</p>}
              {error && <p className="error-text">{error}</p>}
            </section>

            <section className="approve-box">
              {variant.approved ? (
                <>
                  <p className="ok">{t('templateVariant.approvedNote')}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.approve(variant.id, false))}
                  >
                    {t('templateVariant.unapprove')}
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
                    {t('templateVariant.approve')}
                  </button>
                  {render && !render.publishable && (
                    <p className="warn small">{t('templateVariant.notPublishable')}</p>
                  )}
                </>
              )}
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void run(() => api.discard(variant.id, !variant.discarded), onClose)}
              >
                {variant.discarded ? t('templateVariant.restore') : t('templateVariant.discard')}
              </button>
            </section>

            <section>
              <h3>{t('templateVariant.findings')}</h3>
              {!result && <p className="muted">{t('templateVariant.noRender')}</p>}
              {result?.issues.map((issue, i) => (
                <p key={i} className="error-text small" dir="auto">
                  {issue}
                </p>
              ))}
              {slide && (
                <>
                  <p className="small muted">
                    {t('templateVariant.slideLabel', { number: at + 1, name: slide.name })}
                    {/* How much of what the slide shows is its own to edit (ADR-094). */}
                    {slide.editability !== undefined &&
                      ` · ${t('variant.editablePercent', {
                        percent: Math.round(slide.editability * 100),
                      })}`}
                  </p>
                  <SlideFindings slide={slide} />
                </>
              )}
            </section>

            <section>
              <h3>{t('templateVariant.changeRequest')}</h3>
              <textarea
                rows={3}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t('templateVariant.feedbackPlaceholder', { number: at + 1 })}
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
                {t('templateVariant.sendToClaude')}
              </button>
            </section>

            {variant.brief.instructions && (
              <details>
                <summary>{t('templateVariant.instructions')}</summary>
                <p dir="auto">{variant.brief.instructions}</p>
              </details>
            )}

            <section className="log-box">
              <h3>{t('templateVariant.log')}</h3>
              <Log variant={variant} />
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
