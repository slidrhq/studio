import { BASE_LANGUAGES, CONTENT_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Lang,
  type LibraryInfo,
  type RequestKind,
  type StudioRequest,
  type TemplateInfo,
} from './api';
import { designLanguages } from './design';
import { useT, type MessageKey } from './i18n';
import { EFFORTS, MODELS } from './labels';

const isBase = (lang: Lang) => (BASE_LANGUAGES as readonly Lang[]).includes(lang);

/**
 * The languages to make the designs in. Hebrew and English are always made (the app gives the
 * English design to a deck in a language it was not made in), so they are ticked and fixed; any
 * other is made only when ticked for this request.
 */
function Languages({ extra, onChange }: { extra: Lang[]; onChange: (extra: Lang[]) => void }) {
  const t = useT();
  return (
    <fieldset className="languages">
      <legend>{t('form.languages')}</legend>
      <div className="language-list">
        {CONTENT_LANGUAGES.map((lang) => {
          const base = isBase(lang);
          return (
            <label key={lang} className="language" title={LANGUAGE_NAMES[lang].english}>
              <input
                type="checkbox"
                checked={base || extra.includes(lang)}
                disabled={base}
                onChange={(event) =>
                  onChange(
                    event.target.checked ? [...extra, lang] : extra.filter((one) => one !== lang),
                  )
                }
              />
              <span lang={lang} dir="auto">
                {LANGUAGE_NAMES[lang].native}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The languages to write a template's sample in. A language the sample lacks is a translation;
 * one it has is a rewrite, as the instructions describe. Each is a variant of its own.
 */
function SampleLanguages({
  template,
  chosen,
  onChange,
}: {
  template: TemplateInfo;
  chosen: Lang[];
  onChange: (chosen: Lang[]) => void;
}) {
  const t = useT();
  const has = new Set(template.languages);
  return (
    <fieldset className="languages">
      <legend>{t('form.sampleLanguages')}</legend>
      <div className="language-list">
        {CONTENT_LANGUAGES.map((lang) => (
          <label
            key={lang}
            className={`language${has.has(lang) ? ' written' : ''}`}
            title={`${LANGUAGE_NAMES[lang].english}${has.has(lang) ? ` · ${t('form.alreadyWritten')}` : ''}`}
          >
            <input
              type="checkbox"
              checked={chosen.includes(lang)}
              onChange={(event) =>
                onChange(
                  event.target.checked ? [...chosen, lang] : chosen.filter((one) => one !== lang),
                )
              }
            />
            <span lang={lang} dir="auto">
              {LANGUAGE_NAMES[lang].native}
            </span>
            {has.has(lang) && <span className="muted small">✓</span>}
          </label>
        ))}
      </div>
      <div className="language-actions">
        <button type="button" className="link" onClick={() => onChange(template.missing)}>
          {t('form.allMissingLanguages', { count: template.missing.length })}
        </button>
        <button type="button" className="link" onClick={() => onChange([])}>
          {t('form.clear')}
        </button>
      </div>
    </fieldset>
  );
}

const KINDS: { value: RequestKind; label: MessageKey }[] = [
  { value: 'auto', label: 'form.kindAuto' },
  { value: 'design', label: 'form.kindDesign' },
  { value: 'template', label: 'form.kindTemplate' },
];

const EXAMPLES: { text: MessageKey; kind: RequestKind }[] = [
  { text: 'form.example.translate', kind: 'auto' },
  { text: 'form.example.invitation', kind: 'auto' },
  { text: 'form.example.webinar', kind: 'auto' },
  { text: 'form.example.thumbnail', kind: 'auto' },
];

const INTRO: Record<RequestKind, MessageKey> = {
  auto: 'form.introAuto',
  design: 'form.introDesign',
  template: 'form.introTemplate',
};

/** A new request: what to make, and how Claude works on it. */
export function RequestForm({ onCreated }: { onCreated: (request: StudioRequest) => void }) {
  const t = useT();
  const [kind, setKind] = useState<RequestKind>('auto');
  const [prompt, setPrompt] = useState('');
  const [group, setGroup] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [reviewRounds, setReviewRounds] = useState(2);
  // The languages ticked beside Hebrew and English: none by default.
  const [extra, setExtra] = useState<Lang[]>([]);
  const [library, setLibrary] = useState<LibraryInfo>();
  const [templates, setTemplates] = useState<TemplateInfo[]>();
  const [templatesError, setTemplatesError] = useState<string>();
  const [templateId, setTemplateId] = useState('');
  const [sampleLangs, setSampleLangs] = useState<Lang[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.library().then(setLibrary, () => undefined);
    api.templates().then(
      ({ templates: read }) => setTemplates(read),
      (failure: unknown) =>
        setTemplatesError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, []);

  const template = templates?.find((one) => one.id === templateId);
  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    // A template is first offered the languages its sample lacks.
    setSampleLangs(templates?.find((one) => one.id === id)?.missing ?? []);
  };

  const ready =
    kind === 'template' ? Boolean(template) && sampleLangs.length > 0 : prompt.trim().length >= 3;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const languages = kind === 'template' ? sampleLangs : designLanguages(extra);
      onCreated(
        await api.newRequest({
          kind,
          prompt,
          ...(kind === 'template' ? { templateId } : {}),
          group,
          model,
          effort,
          reviewRounds,
          languages,
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const action =
    kind === 'template'
      ? sampleLangs.length === 1
        ? t('form.writeSampleOne')
        : t('form.writeSampleMany', { count: sampleLangs.length })
      : t('form.send');

  return (
    <form className="request-form" onSubmit={(event) => void submit(event)}>
      <div className="form-intro">
        <h2>{t('form.newRequest')}</h2>
        <div className="segmented" role="group" aria-label={t('form.whatToMake')}>
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <p>
          {t(INTRO[kind])} {t('form.introTail')}
        </p>
      </div>

      {kind === 'template' && (
        <label className="field">
          <span>{t('form.template')}</span>
          <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>
            <option value="">
              {templates ? t('form.chooseTemplate') : t('form.loadingTemplates')}
            </option>
            {templates?.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name.he} · {one.name.en} —{' '}
                {one.missing.length === 0
                  ? t('form.inAllLanguages')
                  : t('form.templateLanguageStatus', {
                      count: one.languages.length,
                      missing: one.missing.length,
                    })}
              </option>
            ))}
          </select>
          {templatesError && <span className="error-text">{templatesError}</span>}
          {template?.tagline.he && <span className="muted small">{template.tagline.he}</span>}
        </label>
      )}
      {kind === 'template' && template && (
        <SampleLanguages template={template} chosen={sampleLangs} onChange={setSampleLangs} />
      )}

      <label className="field">
        <span>
          {kind === 'template'
            ? t('form.extraInstructions')
            : kind === 'auto'
              ? t('form.theRequest')
              : t('form.whatToMake')}
        </span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={kind === 'template' ? 3 : 5}
          required={kind !== 'template'}
          minLength={kind === 'template' ? undefined : 3}
          placeholder={
            kind === 'template'
              ? t('form.placeholderTemplate')
              : kind === 'auto'
                ? t('form.placeholderAuto')
                : t('form.placeholderDesign')
          }
        />
      </label>
      {kind !== 'template' && (
        <div className="examples">
          {EXAMPLES.map((example) => (
            <button
              type="button"
              key={example.text}
              className="chip"
              onClick={() => {
                setPrompt(t(example.text));
                setKind(example.kind);
              }}
            >
              {t(example.text)}
            </button>
          ))}
        </div>
      )}

      <div className="form-grid">
        {kind !== 'template' && (
          <>
            <label className="field">
              <span>{t('form.galleryGroup')}</span>
              <select value={group} onChange={(event) => setGroup(event.target.value)}>
                <option value="">{t('form.claudeChooses')}</option>
                {library?.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.he ? `${g.he} · ${g.id}` : g.id}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field">
          <span>{t('form.model')}</span>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.labelKey ? t(m.labelKey) : m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('form.effort')}</span>
          <select value={effort} onChange={(event) => setEffort(event.target.value)}>
            {EFFORTS.map((e) => (
              <option key={e.value} value={e.value}>
                {t(e.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('form.reviewRounds')}</span>
          <select
            value={reviewRounds}
            onChange={(event) => setReviewRounds(Number(event.target.value))}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('form.none') : n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        {kind === 'template' ? t('form.hintTemplate') : t('form.hintDesign')}
        {kind !== 'template' && library && !library.reachable && t('form.libraryUnreachable')}
      </p>

      {kind !== 'template' && (
        <>
          <Languages extra={extra} onChange={setExtra} />
          <p className="hint">
            {kind === 'auto' && t('form.langHintIfDesign')}
            {t('form.langHintMain')}
            {kind === 'auto' && t('form.langHintIfTemplate')}
          </p>
        </>
      )}

      {error && <p className="error-text">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          {busy ? t('form.sending') : action}
        </button>
      </div>
    </form>
  );
}
