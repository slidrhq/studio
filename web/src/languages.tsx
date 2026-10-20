import { BASE_LANGUAGES, CONTENT_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import type { Lang } from './design';
import { useT } from './i18n';

/** A language's name in its own language, such as German or Hebrew. */
export const nativeName = (lang: Lang) => LANGUAGE_NAMES[lang].native;

/** Whether every piece is written in a language: Hebrew and English. */
export const isBase = (lang: Lang) => (BASE_LANGUAGES as readonly Lang[]).includes(lang);

/** Languages, each by its own name; a dash for none. */
export function LanguageNames({ langs }: { langs: readonly Lang[] }) {
  if (!langs.length) return <>—</>;
  return (
    <span className="language-names">
      {langs.map((one) => (
        <bdi key={one} lang={one}>
          {nativeName(one)}
        </bdi>
      ))}
    </span>
  );
}

/**
 * The language shown: a button each for Hebrew and English, and a list of the others. A piece
 * gives the languages it is written in as `langs`, and is shown in none other.
 */
export function LanguagePicker({
  langs = CONTENT_LANGUAGES,
  lang,
  onChange,
  label,
}: {
  langs?: readonly Lang[];
  lang: Lang;
  onChange: (lang: Lang) => void;
  label?: string;
}) {
  const t = useT();
  const base = langs.filter(isBase);
  const others = langs.filter((option) => !isBase(option));
  const other = others.includes(lang);
  return (
    <div
      className="segmented language-picker"
      role="group"
      aria-label={label ?? t('shell.language')}
    >
      {base.map((option) => (
        <button
          type="button"
          key={option}
          lang={option}
          aria-pressed={lang === option}
          onClick={() => onChange(option)}
        >
          {nativeName(option)}
        </button>
      ))}
      {others.length > 0 && (
        <select
          value={other ? lang : ''}
          onChange={(event) => onChange(event.target.value as Lang)}
          aria-label={t('shell.anotherLanguage')}
          className={other ? 'chosen' : undefined}
          lang={other ? lang : undefined}
        >
          <option value="" hidden>
            {base.length
              ? t('shell.moreLanguages', { count: others.length })
              : t('shell.languageEllipsis')}
          </option>
          {others.map((option) => (
            <option key={option} value={option} lang={option}>
              {nativeName(option)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
