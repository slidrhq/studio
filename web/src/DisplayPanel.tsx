import { CONTENT_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import { Button, EmptyState, SegmentedControl, Select } from '@slidr/ui';
import { CircleAlert, GalleryVerticalEnd, ListChecks, Send, X } from '@slidr/ui/icons';
import { useMemo, useState } from 'react';
import { useStudio, type Lang, type Variant } from './api';
import { useLang, useT } from './i18n';
import { OutputCard, outputName, useApprove } from './OutputCard';
import { awaitsApproval } from './outputs';
import { setUi, useUi, type Scope } from './ui';

/**
 * The outputs, as the app's stage shows a slide: on the canvas, under a floating toolbar. Every
 * output is a card (a design, a template's sample in one language); the person selects them for
 * the chat to change, or approves them, one at a time or the selection at once.
 */
export function DisplayPanel() {
  const t = useT();
  const [uiLang] = useLang();
  const studio = useStudio();
  const ui = useUi();
  const approve = useApprove();
  const lang: Lang = ui.displayLang ?? uiLang;
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ variantId: string; error?: string }[]>([]);

  const inScope = useMemo(() => {
    const requests =
      ui.scope === 'all'
        ? studio.requests
        : studio.requests.filter((request) => ui.chatId && request.chatId === ui.chatId);
    return requests.flatMap((request) =>
      request.variantIds.flatMap((vid) => (studio.variants[vid] ? [studio.variants[vid]] : [])),
    );
  }, [studio.requests, studio.variants, ui.scope, ui.chatId]);
  const discarded = inScope.filter((variant) => variant.discarded).length;
  const listed = showDiscarded ? inScope : inScope.filter((variant) => !variant.discarded);
  const waiting = listed.filter(awaitsApproval);
  const chosen = ui.selected
    .map((vid) => studio.variants[vid])
    .filter((variant): variant is Variant => variant !== undefined && awaitsApproval(variant));

  const approveChosen = () => {
    setBusy(true);
    setRefused([]);
    approve(chosen)
      .then(
        (failed) => {
          setRefused(failed);
          setUi({ selected: ui.selected.filter((vid) => failed.some((f) => f.variantId === vid)) });
        },
        (failure: unknown) =>
          setRefused([
            { variantId: '', error: failure instanceof Error ? failure.message : String(failure) },
          ]),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-ui-canvas" aria-label={t('display.title')}>
      <div className="mx-3 mt-3 flex h-toolbar shrink-0 items-center gap-2 rounded-panel border border-ui-line bg-ui-raised px-3 shadow-floating">
        <h2 className="shrink-0 text-md font-semibold">{t('display.title')}</h2>
        <span className="shrink-0 text-xs text-ui-fg-muted">{listed.length || ''}</span>
        <SegmentedControl<Scope>
          aria-label={t('display.scope')}
          size="sm"
          value={ui.scope}
          onValueChange={(scope) => setUi({ scope })}
          options={[
            { value: 'chat', label: t('display.scopeChat') },
            { value: 'all', label: t('display.scopeAll') },
          ]}
        />
        <Select<Lang>
          aria-label={t('display.language')}
          size="sm"
          variant="ghost"
          value={lang}
          onValueChange={(next) => setUi({ displayLang: next })}
          options={CONTENT_LANGUAGES.map((one) => ({
            value: one,
            label: LANGUAGE_NAMES[one].native,
          }))}
        />
        <span className="min-w-0 flex-1" />
        {waiting.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={ListChecks}
            onClick={() => setUi({ selected: waiting.map((variant) => variant.id) })}
          >
            {t('display.selectWaiting', { count: waiting.length })}
          </Button>
        )}
        {ui.selected.length > 0 && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => setUi({ selected: [] })}>
            {t('display.clearSelection')}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          icon={Send}
          loading={busy}
          disabled={chosen.length === 0}
          onClick={approveChosen}
          data-testid="approve-selected"
        >
          {t('display.approveSelected', { count: chosen.length })}
        </Button>
      </div>
      {refused.length > 0 && (
        <div
          role="alert"
          className="mx-3 mt-2 flex items-start gap-2 rounded-panel bg-ui-danger-soft px-3 py-2 text-sm text-ui-danger-fg"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <ul className="min-w-0 flex-1">
            {refused.map((item, i) => (
              <li key={i} dir="auto">
                {studio.variants[item.variantId]
                  ? `${outputName(studio.variants[item.variantId]!, lang)}: `
                  : ''}
                {item.error}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="cursor-default"
            aria-label={t('display.dismiss')}
            onClick={() => setRefused([])}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listed.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={GalleryVerticalEnd}
            title={t('display.emptyTitle')}
            description={
              ui.scope === 'chat' && inScope.length === 0 && studio.requests.length > 0
                ? t('display.emptyChat')
                : t('display.emptyAbout')
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] items-start gap-4 p-4">
            {listed.map((variant) => (
              <OutputCard
                key={variant.id}
                variant={variant}
                lang={lang}
                selected={ui.selected.includes(variant.id)}
                highlighted={ui.highlight.includes(variant.id)}
              />
            ))}
          </div>
        )}
        {discarded > 0 && (
          <div className="px-4 pb-4">
            <Button size="sm" variant="ghost" onClick={() => setShowDiscarded(!showDiscarded)}>
              {showDiscarded
                ? t('display.hideDiscarded')
                : t('display.showDiscarded', { count: discarded })}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
