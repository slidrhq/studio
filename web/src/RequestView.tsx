import { BASE_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import { useState } from 'react';
import {
  api,
  isRunning,
  isTemplate,
  languagesOfVariant,
  renderPicture,
  type Lang,
  type StudioRequest,
  type Variant,
} from './api';
import { useT } from './i18n';
import { money, STAGE, STATUS } from './labels';
import { SlideView } from './SlideView';

function Badge({ variant }: { variant: Variant }) {
  const t = useT();
  if (variant.published && variant.published.revision === variant.revision) {
    return <span className="badge published">{t('request.badgePublished')}</span>;
  }
  if (variant.approved) return <span className="badge approved">{t('request.badgeApproved')}</span>;
  if (variant.published) return <span className="badge changed">{t('request.badgeChanged')}</span>;
  return null;
}

export function StatusLine({ variant }: { variant: Variant }) {
  useT();
  const running = isRunning(variant);
  const stage = variant.stage ? (STAGE[variant.stage] ?? variant.stage) : undefined;
  return (
    <span className={`status status-${variant.status}`}>
      {running && <span className="spinner" aria-hidden />}
      {STATUS[variant.status]}
      {stage && ` · ${stage}`}
    </span>
  );
}

/** The name of a template variant's language, in its own words. */
export function LanguageName({ lang }: { lang: Lang }) {
  return (
    <bdi lang={lang} dir="auto">
      {LANGUAGE_NAMES[lang].native}
    </bdi>
  );
}

function VariantCard({
  variant,
  lang,
  onOpen,
}: {
  variant: Variant;
  lang: Lang;
  onOpen: () => void;
}) {
  const t = useT();
  const render = variant.render;
  const template = isTemplate(variant) && variant.lang ? variant.lang : undefined;
  return (
    <article className={`card${variant.discarded ? ' discarded' : ''}`}>
      <button
        type="button"
        className="card-picture"
        onClick={onOpen}
        aria-label={t('request.openAria', { name: variant.brief.name.he })}
      >
        {render && template ? (
          // A template's sample: its opening slide, as the render took it.
          <img
            className="slide-picture"
            src={renderPicture(variant, 's01-thumb')}
            alt=""
            width={384}
            height={216}
          />
        ) : render ? (
          <SlideView variant={variant} lang={lang} />
        ) : (
          <div className="slide-empty working">
            <StatusLine variant={variant} />
          </div>
        )}
      </button>
      <div className="card-body">
        <div className="card-title">
          {template ? (
            <>
              <strong>
                <LanguageName lang={template} />
              </strong>
              <span className="muted">
                {variant.brief.name.he} · {LANGUAGE_NAMES[template].english}
                {variant.brief.rewrite && ` · ${t('request.rewrite')}`}
              </span>
            </>
          ) : (
            <>
              <strong>{variant.brief.name.he}</strong>
              <span className="muted" dir="ltr">
                {variant.brief.name.en}
              </span>
            </>
          )}
        </div>
        <div className="card-meta">
          <StatusLine variant={variant} />
          <Badge variant={variant} />
        </div>
        {render && (
          <div className="card-meta small">
            <span className={render.errors ? 'warn' : 'ok'}>
              {t('request.errorsWarnings', { errors: render.errors, warnings: render.warnings })}
            </span>
            {!render.publishable && (
              <span className="warn">
                {template ? t('request.failsSampleContract') : t('request.failsGalleryContract')}
              </span>
            )}
            {!template && (
              <span className="muted">{variant.brief.groupName?.he ?? variant.brief.group}</span>
            )}
          </div>
        )}
        {variant.error && <p className="error-text clamp">{variant.error}</p>}
      </div>
    </article>
  );
}

/** One request: its prompt, and its variants side by side. */
export function RequestView({
  request,
  variants,
  lang,
  onOpen,
  onClosed,
}: {
  request: StudioRequest;
  variants: Variant[];
  lang: Lang;
  onOpen: (vid: string) => void;
  onClosed: () => void;
}) {
  const t = useT();
  const [more, setMore] = useState(2);
  const [error, setError] = useState<string>();
  const running = request.status === 'planning' || variants.some(isRunning);
  const cost = request.cost + variants.reduce((sum, variant) => sum + variant.cost, 0);
  const shown = variants.filter((variant) => !variant.discarded);
  const hidden = variants.length - shown.length;
  const [showHidden, setShowHidden] = useState(false);
  // Only the variants made in the language shown: none is drawn in English instead. A template's
  // variant is the sample in one language, a design's is made in its request's languages.
  const madeIn = (variant: Variant) =>
    isTemplate(variant)
      ? (variant.lang ?? lang) === lang
      : languagesOfVariant(variant).includes(lang);
  const listed = (showHidden ? variants : shown).filter(madeIn);
  const elsewhere = (showHidden ? variants : shown).length - listed.length;
  // A request from before there was a choice is made in Hebrew and English.
  const languages: readonly Lang[] = request.languages?.length ? request.languages : BASE_LANGUAGES;
  const kind = request.kind ?? 'design';
  const template = kind === 'template' ? variants.find(isTemplate)?.brief.name : undefined;
  // While a request in words is read, one card says so; a template request shows a card for
  // each language whose variant is not made yet.
  const pending =
    kind === 'auto'
      ? 1
      : kind === 'template'
        ? Math.max(0, languages.length - variants.length)
        : variants.length
          ? more
          : (request.count ?? 1);

  const run = (work: Promise<unknown>) =>
    work.then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );

  const close = () => {
    const pending = variants.filter((variant) => variant.approved && !variant.published);
    const question = pending.length
      ? t('request.closeConfirmPending', { count: pending.length })
      : t('request.closeConfirm');
    if (!window.confirm(question)) return;
    void run(api.deleteRequest(request.id).then(onClosed));
  };

  return (
    <section className="request">
      <header className="request-head">
        <div>
          {kind === 'template' ? (
            <p className="prompt">
              {t('request.templateSampleIntro')}{' '}
              <strong>{template ? `${template.he} (${template.en})` : request.templateId}</strong>{' '}
              {languages.length === 1
                ? t('request.inOneLanguage')
                : t('request.inNLanguages', { count: languages.length })}
              {request.instructions && (
                <>
                  <br />
                  <span dir="auto">{request.instructions}</span>
                </>
              )}
            </p>
          ) : (
            <p className="prompt">{request.prompt}</p>
          )}
          {request.route?.reason && (
            <p className="small route" dir="auto">
              {kind === 'template' ? t('request.understood') : ''}
              {request.route.reason}
            </p>
          )}
          <p className="muted small">
            {kind === 'design' && t('request.proposalCount', { count: request.count ?? 1 })}
            {kind === 'template' ? t('request.writtenIn') : t('request.languagesLabel')}
            {languages.map((lang, i) => (
              <span key={lang}>
                {i > 0 && ', '}
                <bdi lang={lang}>{LANGUAGE_NAMES[lang].native}</bdi>
              </span>
            ))}{' '}
            · {t('request.reviewRounds', { count: request.reviewRounds })}
            {request.model && ` · ${request.model}`}
            {request.effort && ` · ${t('request.effort', { effort: request.effort })}`}
            {request.group && ` · ${t('request.group', { group: request.group })}`}
            {cost > 0 && ` · ${money(cost)}`}
          </p>
        </div>
        <div className="actions">
          {kind === 'design' && (
            <>
              <select
                value={more}
                onChange={(event) => setMore(Number(event.target.value))}
                aria-label={t('request.moreCountAria')}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void run(api.more(request.id, more))}
                disabled={request.status === 'planning'}
              >
                {t('request.moreProposals')}
              </button>
            </>
          )}
          {running && (
            <button type="button" onClick={() => void run(api.cancelRequest(request.id))}>
              {t('request.stopAll')}
            </button>
          )}
          <button type="button" className="ghost" onClick={close}>
            {t('request.closeRequest')}
          </button>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}
      {request.status === 'failed' && request.error && (
        <p className="error-text" dir="auto">
          {kind === 'auto' ? t('request.autoFailed') : t('request.planFailed')}
          {request.error}
        </p>
      )}

      <div className="grid">
        {listed.map((variant) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            lang={lang}
            onOpen={() => onOpen(variant.id)}
          />
        ))}
        {request.status === 'planning' &&
          Array.from({ length: pending }, (_, i) => (
            <article className="card placeholder" key={`plan-${i}`}>
              <div className="slide-empty working">
                <span className="status">
                  <span className="spinner" aria-hidden />{' '}
                  {kind === 'auto'
                    ? t('request.readingRequest')
                    : kind === 'template'
                      ? t('request.preparingTemplate')
                      : t('request.planningConcepts')}
                </span>
              </div>
              <div className="card-body">
                <div className="bar" />
                <div className="bar short" />
              </div>
            </article>
          ))}
      </div>
      {elsewhere > 0 && (
        <p className="muted small">
          {elsewhere === 1
            ? t('request.elsewhereOne')
            : t('request.elsewhereMany', { count: elsewhere })}
          <bdi lang={lang}>{LANGUAGE_NAMES[lang].native}</bdi>.
        </p>
      )}
      {hidden > 0 && (
        <button type="button" className="link" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? t('request.hideRejected') : t('request.showRejected', { count: hidden })}
        </button>
      )}
    </section>
  );
}
