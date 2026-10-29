import { CONTENT_LANGUAGES, LANGUAGE_NAMES, languagesOf } from '@slidr/model';
import { Button, cx, IconButton, Input, Select } from '@slidr/ui';
import {
  ArchiveRestore,
  ImagePlus,
  Languages,
  MessageSquare,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from '@slidr/ui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, isRunning, languagesOfVariant, type Lang, type Variant } from './api';
import type { DesignResult } from './design';
import { useLang, useT } from './i18n';
import { LOG_KIND, LOG_PLAIN, money, time } from './labels';
import { StateLine, useApprove } from './OutputCard';
import { approveAction, awaitsApproval, shownLanguage } from './outputs';
import { SlideView, useResult } from './SlideView';
import { changeInChat, useUi } from './ui';

const THUMB = 240;
const nameOf = (lang: Lang) => LANGUAGE_NAMES[lang].native;

/** A tag-like label in a list of findings or of the log. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span
      dir="auto"
      className="shrink-0 rounded-small bg-ui-field px-1.5 text-2xs font-medium leading-5 text-ui-fg-muted"
    >
      {children}
    </span>
  );
}

/** A section of the side of the detail: its heading and what it holds. */
export function Side({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-ui-line px-4 py-3 last:border-b-0">
      {title && <h3 className="text-xs font-semibold text-ui-fg-muted">{title}</h3>}
      {children}
    </section>
  );
}

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
  if (rows.length === 0)
    return <p className="text-sm text-ui-success-fg">{t('variant.findingsNone')}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <li
          key={i}
          className={cx(
            'flex flex-wrap items-start gap-1 text-xs',
            row.severe ? 'text-ui-danger-fg' : 'text-ui-fg',
          )}
        >
          <Tag>{row.lang}</Tag>
          <Tag>{row.kind}</Tag>
          <span dir="auto" className="min-w-0 flex-1 wrap-anywhere">
            {row.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Log({ variant }: { variant: Variant }) {
  const t = useT();
  const [lang] = useLang();
  const list = useRef<HTMLOListElement>(null);
  // The list follows its newest line; the panel around it stays where the person left it.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [variant.log.length]);
  return (
    <ol ref={list} className="flex max-h-72 flex-col gap-1 overflow-y-auto select-text">
      {variant.log.map((entry, i) => {
        const kind = LOG_KIND[entry.kind];
        return (
          <li
            key={i}
            className={cx(
              'flex items-start gap-1.5 text-xs',
              entry.kind === 'error' && 'text-ui-danger-fg',
            )}
          >
            <span dir="ltr" className="shrink-0 font-mono text-2xs leading-5 text-ui-fg-subtle">
              {time(entry.t, lang)}
            </span>
            <Tag>{kind ? t(kind) : (LOG_PLAIN[entry.kind] ?? entry.kind)}</Tag>
            <span dir="auto" className="min-w-0 flex-1 leading-5 wrap-anywhere">
              {entry.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The frame of an output up close: the dialog, its title bar, the stage and the side. */
export function DetailFrame({
  label,
  title,
  subtitle,
  tools,
  onClose,
  stage,
  side,
}: {
  label: string;
  title: ReactNode;
  subtitle: ReactNode;
  tools?: ReactNode;
  onClose: () => void;
  stage: ReactNode;
  side: ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex animate-fade-in items-stretch justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex min-h-0 w-full max-w-[1500px] animate-overlay-in flex-col overflow-hidden rounded-panel border border-ui-line bg-ui-panel shadow-overlay">
        <header className="flex shrink-0 items-center gap-3 border-b border-ui-line px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="truncate text-lg font-semibold">{title}</h2>
            <p dir="ltr" className="truncate text-start text-xs text-ui-fg-muted">
              {subtitle}
            </p>
          </div>
          {tools}
          <IconButton icon={X} label={t('variant.close')} onClick={onClose} />
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-ui-canvas p-5">
            {stage}
          </div>
          <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-s border-ui-line">
            {side}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** One design, up close: every language at full size and as the gallery's thumbnail. */
export function VariantDetail({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const t = useT();
  const [uiLang] = useLang();
  const displayLang = useUi((ui) => ui.displayLang);
  const approve = useApprove();
  const [lang, setLang] = useState<Lang>(displayLang ?? uiLang);
  const [imageNote, setImageNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const result = useResult(variant);
  const running = isRunning(variant);
  const render = variant.render;
  const made = result ? languagesOf(result.langs) : [];
  const langs = made.length ? made : languagesOfVariant(variant, result);
  const shown = shownLanguage(variant, lang);
  const action = approveAction(variant);

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

  const name = uiLang === 'he' ? variant.brief.name.he : variant.brief.name.en;
  const other = uiLang === 'he' ? variant.brief.name.en : variant.brief.name.he;
  const tagLangs = CONTENT_LANGUAGES.filter((one) => variant.brief.tags?.[one]?.length);

  return (
    <DetailFrame
      label={name}
      title={
        <>
          <span dir="auto">{name}</span> <span className="text-ui-fg-muted">·</span>{' '}
          <span dir="auto" className="text-ui-fg-muted">
            {other}
          </span>
        </>
      }
      subtitle={[
        variant.designId,
        variant.brief.group,
        render && `revision ${render.revision}`,
        money(variant.cost),
      ]
        .filter(Boolean)
        .join(' · ')}
      tools={
        <Select<Lang>
          aria-label={t('display.language')}
          size="sm"
          className="w-36"
          value={shown}
          onValueChange={setLang}
          options={langs.map((one) => ({ value: one, label: nameOf(one) }))}
        />
      }
      onClose={onClose}
      stage={
        render ? (
          <>
            {/* Its own height: in the column, a box that hides its overflow may shrink to none. */}
            <div className="shrink-0 overflow-hidden rounded-panel shadow-slide">
              <SlideView variant={variant} lang={shown} result={result} />
            </div>
            <h3 className="text-sm font-semibold">{t('variant.galleryPreview')}</h3>
            <div className="flex flex-wrap gap-3">
              {made.map((side) => (
                <figure key={side} className="flex flex-col gap-1">
                  <button
                    type="button"
                    className={cx(
                      'cursor-default overflow-hidden rounded-control border-2',
                      side === shown ? 'border-ui-accent' : 'border-transparent',
                    )}
                    onClick={() => setLang(side)}
                  >
                    <SlideView variant={variant} lang={side} width={THUMB} result={result} />
                  </button>
                  <figcaption lang={side} dir="auto" className="text-xs text-ui-fg-muted">
                    {nameOf(side)}
                    {render.editability[side] !== undefined &&
                      ` · ${t('variant.editablePercent', {
                        percent: Math.round((render.editability[side] ?? 0) * 100),
                      })}`}
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="text-xs text-ui-fg-muted">{t('variant.renderNote')}</p>
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
                  {t('variant.stop')}
                </Button>
              )}
              {(variant.status === 'failed' || variant.status === 'cancelled') && (
                <Button
                  size="sm"
                  icon={RotateCcw}
                  onClick={() => void run(() => api.retry(variant.id))}
                >
                  {t('variant.retry')}
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
                variant={action === 'translate' ? 'soft' : 'primary'}
                icon={action === 'translate' ? Languages : Send}
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    const refused = await approve([variant]);
                    if (refused[0]?.error) throw new Error(refused[0].error);
                  })
                }
              >
                {action === 'translate' ? t('display.approveMaster') : t('display.approvePublish')}
              </Button>
            )}
            {awaitsApproval(variant) && (
              <p className="text-xs text-ui-fg-muted">
                {action === 'translate'
                  ? t('variant.approveMasterNote')
                  : t('variant.approvePublishNote')}
              </p>
            )}
            {render && !render.publishable && variant.status === 'ready' && (
              <p className="text-xs text-ui-warning-fg">{t('variant.notPublishable')}</p>
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
                {variant.discarded ? t('variant.restore') : t('variant.discard')}
              </Button>
            </div>
          </Side>

          <Side title={t('variant.findings')}>
            {result ? (
              <Findings result={result} />
            ) : (
              <p className="text-xs text-ui-fg-muted">{t('variant.noRender')}</p>
            )}
          </Side>

          <Side title={t('variant.image')}>
            {variant.image && (
              <details className="text-xs">
                <summary className="cursor-default text-ui-fg-muted">
                  {variant.image.width}×{variant.image.height} · {t('variant.imagePromptSummary')}
                </summary>
                <p dir="ltr" className="mt-1 text-ui-fg-muted select-text">
                  {variant.image.prompt}
                </p>
              </details>
            )}
            <div className="flex gap-1.5">
              <Input
                value={imageNote}
                onChange={(event) => setImageNote(event.target.value)}
                placeholder={t('variant.imageNotePlaceholder')}
                className="min-w-0 flex-1"
              />
              <Button
                icon={ImagePlus}
                disabled={busy || running}
                onClick={() =>
                  void run(
                    () => api.newImage(variant.id, imageNote.trim()),
                    () => setImageNote(''),
                  )
                }
              >
                {imageNote.trim() ? t('variant.changeImage') : t('variant.newImage')}
              </Button>
            </div>
          </Side>

          {(variant.brief.concept || variant.brief.art) && (
            <Side title={t('variant.concept')}>
              <p dir="auto" className="text-xs select-text">
                {variant.brief.concept}
              </p>
              <p dir="auto" className="text-xs text-ui-fg-muted select-text">
                {variant.brief.art}
              </p>
            </Side>
          )}

          {tagLangs.length > 0 && (
            <Side title={t('variant.tags')}>
              <dl className="flex flex-col gap-1.5 text-xs select-text">
                {tagLangs.map((one) => (
                  <div key={one} className="flex items-start gap-1.5">
                    <dt className="shrink-0">
                      <Tag>{nameOf(one)}</Tag>
                    </dt>
                    <dd lang={one} dir="auto" className="min-w-0 flex-1 leading-5">
                      {variant.brief.tags?.[one]?.join(' · ')}
                    </dd>
                  </div>
                ))}
              </dl>
            </Side>
          )}

          <Side title={t('variant.log')}>
            <Log variant={variant} />
          </Side>
        </>
      }
    />
  );
}
