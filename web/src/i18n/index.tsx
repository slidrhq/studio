import { languageDir } from '@slidr/model';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DisplayLang } from '../api';
import { en, he, type MessageKey } from './catalog';

export type { MessageKey };
export type Params = Record<string, string | number>;
type Words = Partial<Record<MessageKey, string>>;
export type Translate = (key: MessageKey, params?: Params) => string;

/** The words of a language other than Hebrew and English, each file read when it is chosen. */
const locales = import.meta.glob<{ default: Words }>('./locales/*.ts');
const read = new Map<string, Words>();

async function loadWords(lang: DisplayLang): Promise<Words> {
  if (lang === 'he') return he;
  if (lang === 'en') return en;
  const known = read.get(lang);
  if (known) return known;
  const load = locales[`./locales/${lang}.ts`];
  const words = load ? (await load()).default : {};
  read.set(lang, words);
  return words;
}

/** A message with its `{name}`s filled in. */
export function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

interface Shown {
  lang: DisplayLang;
  setLang: (lang: DisplayLang) => void;
  t: Translate;
}

const Context = createContext<Shown>({
  lang: 'he',
  setLang: () => undefined,
  t: (key, params) => format(he[key], params),
});

/**
 * The language of the studio: its words, and the direction they read in. Another language than
 * Hebrew and English falls back to English for a message it does not have yet; the language
 * before is kept until the words of the new one are read.
 */
export function I18n({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<DisplayLang>('he');
  const [loaded, setLoaded] = useState<{ lang: DisplayLang; words: Words }>({
    lang: 'he',
    words: he,
  });
  useEffect(() => {
    let live = true;
    loadWords(lang).then(
      (words) => live && setLoaded({ lang, words }),
      () => live && setLoaded({ lang, words: {} }),
    );
    return () => {
      live = false;
    };
  }, [lang]);
  const words = loaded.words;
  useEffect(() => {
    document.documentElement.lang = loaded.lang;
    document.documentElement.dir = languageDir(loaded.lang);
  }, [loaded.lang]);
  const t = useCallback<Translate>(
    (key, params) => format(words[key] ?? en[key] ?? he[key], params),
    [words],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The language shown, and the way to change it. */
export function useLang(): [DisplayLang, (lang: DisplayLang) => void] {
  const { lang, setLang } = useContext(Context);
  return [lang, setLang];
}

/** The words of the studio in the language shown. */
export function useT(): Translate {
  return useContext(Context).t;
}
