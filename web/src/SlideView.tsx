import { pieceLanguage } from '@slidr/model';
import { ScaledSlide } from '@slidr/renderer';
import { useEffect, useMemo, useRef, useState } from 'react';
import { pictureUrl, renderResult, type Lang, type Variant } from './api';
import { designDeck, pictureResolver, type DesignResult } from './design';

/** The width of an element, followed as it changes. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry!.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The converted result of a variant's latest render. */
export function useResult(variant: Variant): DesignResult | undefined {
  const revision = variant.render?.revision;
  const [result, setResult] = useState<{ key: string; value: DesignResult }>();
  const key = `${variant.id}:${revision}`;
  useEffect(() => {
    if (!revision) return;
    let live = true;
    renderResult(variant.id, revision).then(
      (value) => live && setResult({ key, value }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [variant.id, revision, key]);
  return result?.key === key ? result.value : undefined;
}

/**
 * A variant's slide in one language, drawn by the app's renderer from the converted model, at a
 * fixed width or at the width of its container. A language the variant was not made in shows
 * its English slide.
 */
export function SlideView({
  variant,
  lang,
  width: fixed,
  result,
}: {
  variant: Variant;
  lang: Lang;
  width?: number;
  result?: DesignResult;
}) {
  const fetched = useResult(variant);
  const data = result ?? fetched;
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = fixed ?? measured;
  const picture = useMemo(
    () =>
      variant.image
        ? { url: pictureUrl(variant), width: variant.image.width, height: variant.image.height }
        : undefined,
    [variant],
  );
  // A variant not made in the language asked for is shown in English, as the app gives it.
  const shown = data ? pieceLanguage(data.langs, lang) : lang;
  const slide = data?.langs[shown]?.slide;
  const deck = useMemo(
    () => (slide && picture ? designDeck(shown, picture, [slide]) : undefined),
    [slide, picture, shown],
  );
  const resolve = useMemo(() => (picture ? pictureResolver(picture) : undefined), [picture]);
  return (
    <div ref={ref} className="slide-frame" style={fixed ? { width: fixed } : undefined}>
      {deck && slide && width > 0 ? (
        <ScaledSlide
          deck={deck}
          slide={slide}
          width={width}
          mode="thumbnail"
          resolveAsset={resolve}
        />
      ) : (
        <div className="slide-empty" style={{ aspectRatio: '16 / 9' }} />
      )}
    </div>
  );
}
