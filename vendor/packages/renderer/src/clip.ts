import type { AudioElement, VideoElement } from '@slidr/model';
import { num } from './css';

/**
 * What a video or a sound is as a clip (MED-02, MED-03), written on its media element for whoever
 * plays it: the runtime's player in a show and in an exported file, the editor for playback in
 * place. A browser keeps neither a trim nor a loop inside one by itself, so the element only
 * carries them; `packages/runtime/src/media.ts` reads them back and acts on them. The names are
 * repeated there, and a test in `@slidr/html-export` holds the two together.
 */
export const CLIP_ATTRIBUTE = 'data-slidr-clip';
/** On the mark of a sound that shows no controls: a click on it plays and pauses the sound. */
export const CLIP_TOGGLE_ATTRIBUTE = 'data-slidr-clip-toggle';

/** Times are written in seconds, as media elements count them. */
const secs = (ms: number): string => String(num(ms / 1000, 3));

export type ClipAttributes = Record<`data-${string}`, string | undefined>;

/** The attributes of a clip. One that is undefined is left out of the markup. */
export function clipAttributes(e: VideoElement | AudioElement): ClipAttributes {
  const still = e.type === 'video' && e.poster && 'timeMs' in e.poster ? e.poster.timeMs : null;
  return {
    [CLIP_ATTRIBUTE]: e.type,
    'data-clip-start': e.trim ? secs(e.trim.startMs) : undefined,
    'data-clip-end': e.trim ? secs(e.trim.endMs) : undefined,
    'data-clip-loop': e.loop ? '' : undefined,
    'data-clip-autoplay': e.autoplay ? '' : undefined,
    'data-clip-still': still === null ? undefined : secs(still),
  };
}

/**
 * The frame a video shows while it waits, in milliseconds: the chosen frame, else the start of
 * its trim. A poster that is a picture is drawn over it by the browser.
 */
export function stillFrame(e: VideoElement): number {
  return e.poster && 'timeMs' in e.poster ? e.poster.timeMs : (e.trim?.startMs ?? 0);
}

/**
 * Where a video is loaded from, outside a show, so that it shows its still frame with nothing
 * there to put it at one: the file, with the frame as a media fragment. With a picture as the
 * poster there is no fragment: a browser that seeks to one drops the poster. In a show, and so
 * in an exported file, the address is the file's alone, and the runtime's player rests every
 * clip at its poster when its slide is shown.
 */
export function videoSource(e: VideoElement, url: string): string {
  if (e.poster && 'assetId' in e.poster) return url;
  const at = stillFrame(e);
  return at > 0 ? `${url}#t=${secs(at)}` : url;
}

/**
 * Whether the browser's own `loop` does for a clip: it goes back to the start of the file, so
 * only for a clip that is not trimmed. A trimmed loop is the runtime's.
 */
export function nativeLoop(e: VideoElement | AudioElement): boolean {
  return e.loop && !e.trim;
}

/**
 * Whether a sound shows its mark in a show. With the browser's controls it shows those; a sound
 * that starts by itself and has none is heard and not seen; one that waits for a click needs
 * something to click.
 */
export function showsMark(e: AudioElement): boolean {
  return !e.showControls && !e.autoplay;
}
