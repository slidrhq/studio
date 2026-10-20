import { readMediaJson } from '@slidr/media-library';
import type { AssetMeta } from '@slidr/model';

/**
 * The pictures of the built-in templates' samples, by id: `templates/pictures.json` of the media
 * library, which its publisher writes from the catalog. None without the library.
 */
const read = await readMediaJson<Record<string, AssetMeta>>('templates/pictures.json');

export const pictures: Record<string, AssetMeta> =
  read && typeof read === 'object' && !Array.isArray(read) ? read : {};
