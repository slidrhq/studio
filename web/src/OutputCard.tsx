import { LANGUAGE_NAMES } from '@slidr/model';
import {
  Button,
  cx,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Spinner,
} from '@slidr/ui';
import {
  ArchiveRestore,
  Check,
  CircleCheck,
  Ellipsis,
  Expand,
  Languages,
  MessageSquare,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from '@slidr/ui/icons';
import { memo, useState, type ReactNode } from 'react';
import { api, isRunning, isTemplate, renderPicture, type Lang, type Variant } from './api';
import { useT, type MessageKey } from './i18n';
import { STAGE } from './labels';
import {
  approveAction,
  awaitsApproval,
  languageProgress,
  phaseOf,
  shownLanguage,
  stateOf,
  type OutputState,
} from './outputs';
import { SlideView } from './SlideView';
import { changeInChat, setUi, toggleSelected } from './ui';

/** Where an output stands, in a few words. */
export const STATE_LABEL: Record<OutputState, MessageKey> = {
  working: 'display.stateWorking',
  awaitingMaster: 'display.stateAwaitingMaster',
  awaitingPublish: 'display.stateAwaitingPublish',
  failsContract: 'display.stateFailsContract',
  publishing: 'display.statePublishing',
  waitsInLibrary: 'display.stateWaitsInLibrary',
  published: 'display.statePublished',
  changedSincePublished: 'display.stateChanged',
  publishFailed: 'display.statePublishFailed',
  failed: 'display.stateFailed',
  cancelled: 'display.stateCancelled',
};

/** What an output is doing while it works, by its status (and phase). */
function workingLabel(variant: Variant): MessageKey {
  switch (variant.status) {
    case 'queued':
      return 'display.doingQueued';
    case 'image':
      return 'display.doingImage';
    case 'writing':
      return isTemplate(variant)
        ? 'display.doingSample'
        : phaseOf(variant) === 'master'
          ? 'display.doingMaster'
          : 'display.doingDesign';
    case 'rendering':
      return 'display.doingRender';
    case 'reviewing':
      return 'display.doingReview';
    case 'translating':
      return 'display.doingTranslate';
    case 'publishing':
      return 'display.statePublishing';
    default:
      return 'display.stateWorking';
  }
}

/** An output's name: a design's in the language shown (Hebrew or English); a sample's language. */
export function outputName(variant: Variant, lang: Lang): string {
  if (isTemplate(variant) && variant.lang) {
    return `${lang === 'he' ? variant.brief.name.he : variant.brief.name.en} · ${LANGUAGE_NAMES[variant.lang].native}`;
  }
  return (
    variant.brief.names?.[lang] ??
    (lang === 'he' ? variant.brief.name.he : variant.brief.name.en) ??
    variant.brief.name.en
  );
}

const TONE: Partial<Record<OutputState, string>> = {
  awaitingMaster: 'bg-ui-tool-orange text-ui-tool-orange-fg',
  awaitingPublish: 'bg-ui-tool-blue text-ui-tool-blue-fg',
  waitsInLibrary: 'bg-ui-tool-blue text-ui-tool-blue-fg',
  published: 'bg-ui-tool-green text-ui-tool-green-fg',
  changedSincePublished: 'bg-ui-tool-orange text-ui-tool-orange-fg',
  failsContract: 'bg-ui-danger-soft text-ui-danger-fg',
  publishFailed: 'bg-ui-danger-soft text-ui-danger-fg',
  failed: 'bg-ui-danger-soft text-ui-danger-fg',
  cancelled: 'bg-ui-field text-ui-fg-muted',
};

/**
 * Where an output stands: a spinner and what it does, or a tinted pill; of one that waits in the
 * library, the pill says why on hover.
 */
export function StateLine({ variant }: { variant: Variant }) {
  const t = useT();
  const state = stateOf(variant);
  if (state === 'working' || state === 'publishing') {
    const stage = variant.stage ? STAGE[variant.stage] : undefined;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ui-fg-muted">
        <Spinner />
        <span className="truncate">
          {t(workingLabel(variant))}
          {stage && ` · ${t(stage)}`}
        </span>
      </span>
    );
  }
  return (
    <span
      className={cx(
        'inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONE[state] ?? 'bg-ui-field text-ui-fg-muted',
      )}
      title={state === 'waitsInLibrary' ? variant.upload?.note : undefined}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{t(STATE_LABEL[state])}</span>
    </span>
  );
}

/** Approves an output: its English master goes to be translated, or the whole is published. */
export function useApprove() {
  const t = useT();
  return async (variants: Variant[]) => {
    const errors = variants.reduce((sum, variant) => sum + (variant.render?.errors ?? 0), 0);
    if (errors > 0 && !window.confirm(t('display.confirmWithErrors', { count: errors }))) {
      return [];
    }
    const { items } = await api.approveMany(variants.map((variant) => variant.id));
    return items.filter((item) => item.error);
  };
}

/** A picture of the output: its slide in the language shown, or what it is doing meanwhile. */
function Preview({ variant, lang }: { variant: Variant; lang: Lang }) {
  const t = useT();
  if (variant.render && isTemplate(variant)) {
    return (
      <img
        className="block aspect-video w-full object-cover"
        src={renderPicture(variant, 's01-thumb')}
        alt=""
      />
    );
  }
  if (variant.render) return <SlideView variant={variant} lang={shownLanguage(variant, lang)} />;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-ui-field text-xs text-ui-fg-muted">
      {isRunning(variant) ? <Spinner /> : null}
      <span>
        {isRunning(variant) ? t(workingLabel(variant)) : t(STATE_LABEL[stateOf(variant)])}
      </span>
    </div>
  );
}

/**
 * One output: a design concept, or a template's sample in one language. Its picture opens it up
 * close; its box selects it, for the chat to change or to approve with others; its button
 * approves it. `children` is room for many items in one card, as a request of graphics or emoji
 * will have (one card a request, holding what it made).
 *
 * Drawn again only when its props change: a working variant changes with every line of its log,
 * and the other cards of the panel stay as they are.
 */
export const OutputCard = memo(function OutputCard({
  variant,
  lang,
  selected,
  highlighted,
  children,
}: {
  variant: Variant;
  lang: Lang;
  selected: boolean;
  highlighted: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const approve = useApprove();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state = stateOf(variant);
  const progress = languageProgress(variant);
  const waiting = awaitsApproval(variant);
  const action = approveAction(variant);
  const render = variant.render;
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    work()
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };
  const onApprove = () =>
    run(async () => {
      const refused = await approve([variant]);
      if (refused[0]?.error) setError(refused[0].error);
    });
  const secondary = isTemplate(variant)
    ? variant.lang && LANGUAGE_NAMES[variant.lang].english
    : lang === 'he'
      ? variant.brief.name.en
      : variant.brief.name.he;

  return (
    <article
      data-output={variant.id}
      data-state={state}
      className={cx(
        'flex min-w-0 flex-col overflow-hidden rounded-panel border bg-ui-panel shadow-raised transition-[box-shadow,border-color] duration-(--duration-base)',
        selected ? 'border-ui-accent ring-2 ring-ui-accent/30' : 'border-ui-line',
        highlighted && 'ring-4 ring-ui-focus/40',
        variant.discarded && 'opacity-60',
      )}
    >
      <div className="relative">
        <button
          type="button"
          className="block w-full cursor-default overflow-hidden"
          onClick={() => setUi({ detail: variant.id })}
          aria-label={t('display.open', { name: outputName(variant, lang) })}
        >
          <Preview variant={variant} lang={lang} />
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t('display.select', { name: outputName(variant, lang) })}
          onClick={() => toggleSelected(variant.id)}
          className={cx(
            'absolute top-2 start-2 inline-flex size-6 cursor-default items-center justify-center rounded-control border shadow-raised transition-colors',
            selected
              ? 'border-transparent bg-ui-accent text-ui-on-accent'
              : 'border-ui-line-strong bg-ui-raised/90 text-transparent hover:text-ui-fg-subtle',
          )}
        >
          <Icon icon={Check} size="sm" />
        </button>
        {!isTemplate(variant) && (
          <span
            className="absolute top-2 end-2 inline-flex h-6 items-center gap-1 rounded-full bg-ui-raised/90 px-2 text-xs font-medium text-ui-fg-muted shadow-raised"
            title={t('display.languagesMade', progress)}
          >
            <Icon icon={Languages} size="sm" />
            <span dir="ltr">
              {progress.made}/{progress.of}
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start gap-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <span dir="auto" className="truncate text-md font-semibold">
              {outputName(variant, lang)}
            </span>
            {secondary && (
              <span dir="auto" className="truncate text-xs text-ui-fg-muted">
                {secondary}
              </span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton icon={Ellipsis} size="sm" label={t('display.more')} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={Expand} onSelect={() => setUi({ detail: variant.id })}>
                {t('display.openClose')}
              </DropdownMenuItem>
              <DropdownMenuItem icon={MessageSquare} onSelect={() => changeInChat(variant.id)}>
                {t('display.changeInChat')}
              </DropdownMenuItem>
              {isRunning(variant) && (
                <DropdownMenuItem icon={Square} onSelect={() => run(() => api.cancel(variant.id))}>
                  {t('display.stop')}
                </DropdownMenuItem>
              )}
              {(variant.status === 'failed' || variant.status === 'cancelled') && (
                <DropdownMenuItem
                  icon={RotateCcw}
                  onSelect={() => run(() => api.retry(variant.id))}
                >
                  {t('display.retry')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={variant.discarded ? ArchiveRestore : Trash2}
                tone={variant.discarded ? 'default' : 'danger'}
                onSelect={() => run(() => api.discard(variant.id, !variant.discarded))}
              >
                {variant.discarded ? t('display.restore') : t('display.discard')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StateLine variant={variant} />
          {render && (render.errors > 0 || render.warnings > 0) && (
            <span
              className={cx('text-xs', render.errors ? 'text-ui-warning-fg' : 'text-ui-fg-muted')}
            >
              {t('display.findings', { errors: render.errors, warnings: render.warnings })}
            </span>
          )}
        </div>
        {(variant.error || variant.publishError || error) && (
          <p dir="auto" className="line-clamp-3 text-xs text-ui-danger-fg wrap-anywhere">
            {error ?? variant.publishError ?? variant.error}
          </p>
        )}
        {children}
        {waiting && (
          <Button
            variant={action === 'translate' ? 'soft' : 'primary'}
            size="sm"
            icon={action === 'translate' ? Languages : Send}
            loading={busy}
            onClick={onApprove}
            data-approve={action}
          >
            {action === 'translate' ? t('display.approveMaster') : t('display.approvePublish')}
          </Button>
        )}
        {state === 'published' && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ui-success-fg">
            <Icon icon={CircleCheck} size="sm" />
            {t('display.inLibrary')}
          </span>
        )}
      </div>
    </article>
  );
});
