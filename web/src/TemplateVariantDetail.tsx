import { LANGUAGE_NAMES, languageDir } from '@slidr/model';
import { Button, cx } from '@slidr/ui';
import { ArchiveRestore, MessageSquare, RotateCcw, Send, Square, Trash2 } from '@slidr/ui/icons';
import { useEffect, useState } from 'react';
import { api, isRunning, renderPicture, templateResult, type Lang, type Variant } from './api';
import { useLang, useT } from './i18n';
import { money } from './labels';
import { StateLine, useApprove } from './OutputCard';
import { awaitsApproval } from './outputs';
import type { SlideResult, TemplateResult } from './template';
import { changeInChat } from './ui';
import { DetailFrame, Log, Side, Tag } from './VariantDetail';

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
        <p className="text-xs text-ui-success-fg">{t('templateVariant.noFindings')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row, i) => (
            <li
              key={i}
              className={cx(
                'flex flex-wrap items-start gap-1 text-xs',
                row.severe ? 'text-ui-danger-fg' : 'text-ui-fg',
              )}
            >
              <Tag>{row.kind}</Tag>
              <span dir="auto" className="min-w-0 flex-1 wrap-anywhere">
                {row.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {inherited.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-default text-ui-fg-muted">
            {t('templateVariant.inheritedFindings', { count: inherited.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-1.5">
            {inherited.map((finding, i) => (
              <li key={i} className="flex flex-wrap items-start gap-1">
                <Tag>{finding.rule}</Tag>
                <span dir="auto" className="min-w-0 flex-1 wrap-anywhere">
                  {finding.message}
                </span>
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
  const [uiLang] = useLang();
  const approve = useApprove();
  const [index, setIndex] = useState(0);
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
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
        return;
      }
      // The arrows step through the slides in the direction they read.
      const forward = languageDir(lang) === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      if (event.key === forward) setIndex((i) => Math.min(i + 1, Math.max(0, slides.length - 1)));
      if (event.key === back) setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lang, slides.length]);

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

  const templateName = uiLang === 'he' ? variant.brief.name.he : variant.brief.name.en;
  const title = `${templateName} · ${LANGUAGE_NAMES[lang].native}`;
  return (
    <DetailFrame
      label={title}
      title={
        <>
          <span dir="auto">{templateName}</span> <span className="text-ui-fg-muted">·</span>{' '}
          <bdi lang={lang}>{LANGUAGE_NAMES[lang].native}</bdi>
        </>
      }
      subtitle={[
        `templates/catalog.json · samples.${variant.templateId}.${lang}${variant.brief.rewrite ? ' (rewrite)' : ''}`,
        render && `revision ${render.revision}`,
        money(variant.cost),
      ]
        .filter(Boolean)
        .join(' · ')}
      onClose={onClose}
      stage={
        render && slides.length > 0 ? (
          <>
            {slide && (
              <figure className="flex flex-col gap-2">
                {slide.error ? (
                  <div className="flex aspect-video items-center justify-center rounded-panel bg-ui-field p-6">
                    <p dir="auto" className="text-sm text-ui-danger-fg">
                      {t('templateVariant.slideNotBuilt', { error: slide.error })}
                    </p>
                  </div>
                ) : (
                  <img
                    className="block w-full rounded-panel shadow-slide"
                    src={renderPicture(variant, `${slideName(at)}-full`)}
                    alt={slide.name}
                  />
                )}
                <figcaption dir="auto" className="text-xs text-ui-fg-muted">
                  {at + 1} / {slides.length} · {slide.name} · <bdi dir="ltr">{slide.layout}</bdi>
                </figcaption>
              </figure>
            )}
            <h3 className="text-sm font-semibold">{t('templateVariant.allSlides')}</h3>
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2"
              dir={languageDir(lang)}
            >
              {slides.map((one) => {
                const { own, severe } = counts(one);
                return (
                  <button
                    type="button"
                    key={one.index}
                    className={cx(
                      'flex cursor-default flex-col gap-1 rounded-control border-2 p-0.5 text-start',
                      one.index === at
                        ? 'border-ui-accent'
                        : 'border-transparent hover:border-ui-line-strong',
                    )}
                    onClick={() => setIndex(one.index)}
                    aria-label={`${one.index + 1}: ${one.name}`}
                  >
                    {one.error ? (
                      <div className="aspect-video w-full rounded-small bg-ui-field" />
                    ) : (
                      <img
                        className="block aspect-video w-full rounded-small object-cover"
                        src={renderPicture(variant, `${slideName(one.index)}-thumb`)}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <span dir="auto" className="truncate px-0.5 text-2xs text-ui-fg-muted">
                      {one.index + 1}. {one.name}
                      {own > 0 && (
                        <span className={severe ? 'text-ui-warning-fg' : undefined}> · {own}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-ui-fg-muted">{t('templateVariant.sheetNote')}</p>
          </>
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-panel bg-ui-field">
            <StateLine variant={variant} />
          </div>
        )
      }
      side={
        <>
          <Side>
            <div className="flex flex-wrap items-center gap-2">
              <StateLine variant={variant} />
              <span className="flex-1" />
              {running && (
                <Button
                  size="sm"
                  icon={Square}
                  onClick={() => void run(() => api.cancel(variant.id))}
                >
                  {t('templateVariant.stop')}
                </Button>
              )}
              {(variant.status === 'failed' || variant.status === 'cancelled') && (
                <Button
                  size="sm"
                  icon={RotateCcw}
                  onClick={() => void run(() => api.retry(variant.id))}
                >
                  {t('templateVariant.retry')}
                </Button>
              )}
            </div>
            {(variant.error || variant.publishError) && (
              <p dir="auto" className="text-xs text-ui-danger-fg wrap-anywhere">
                {variant.publishError ?? variant.error}
              </p>
            )}
            {error && (
              <p role="alert" dir="auto" className="text-xs text-ui-danger-fg">
                {error}
              </p>
            )}
            {awaitsApproval(variant) && (
              <Button
                variant="primary"
                icon={Send}
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    const refused = await approve([variant]);
                    if (refused[0]?.error) throw new Error(refused[0].error);
                  })
                }
              >
                {t('display.approvePublish')}
              </Button>
            )}
            {render && !render.publishable && variant.status === 'ready' && (
              <p className="text-xs text-ui-warning-fg">{t('templateVariant.notPublishable')}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" icon={MessageSquare} onClick={() => changeInChat(variant.id)}>
                {t('display.changeInChat')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={variant.discarded ? ArchiveRestore : Trash2}
                disabled={busy}
                onClick={() => void run(() => api.discard(variant.id, !variant.discarded), onClose)}
              >
                {variant.discarded ? t('templateVariant.restore') : t('templateVariant.discard')}
              </Button>
            </div>
          </Side>

          <Side title={t('templateVariant.findings')}>
            {!result && <p className="text-xs text-ui-fg-muted">{t('templateVariant.noRender')}</p>}
            {result?.issues.map((issue, i) => (
              <p key={i} dir="auto" className="text-xs text-ui-danger-fg">
                {issue}
              </p>
            ))}
            {slide && (
              <>
                <p className="text-xs text-ui-fg-muted">
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
          </Side>

          {variant.brief.instructions && (
            <Side title={t('templateVariant.instructions')}>
              <p dir="auto" className="text-xs select-text">
                {variant.brief.instructions}
              </p>
            </Side>
          )}

          <Side title={t('templateVariant.log')}>
            <Log variant={variant} />
          </Side>
        </>
      }
    />
  );
}
