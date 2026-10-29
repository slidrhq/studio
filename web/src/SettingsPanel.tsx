import { CONTENT_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import {
  Button,
  cx,
  Icon,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsTile,
  TabsTileList,
} from '@slidr/ui';
import {
  Info,
  Library,
  Monitor,
  Moon,
  Sparkles,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from '@slidr/ui/icons';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useState, type ReactNode } from 'react';
import { AgentFields, AgentMark, ROLE, programName } from './agents';
import {
  AGENT_ROLES,
  api,
  useStudio,
  type AgentChoice,
  type AgentRole,
  type GalleryDrawn,
  type GalleryMissing,
  type ServerStatus,
  type StudioSettings,
} from './api';
import { useLang, useT, type MessageKey } from './i18n';
import { setTheme, useTheme, type ThemeChoice } from './theme';

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/* ---------------------------------------------------------------- layout, as the app's */

function Group({
  title,
  note,
  children,
}: {
  title?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {title && <h4 className="px-1 text-xs font-semibold text-ui-fg-muted">{title}</h4>}
      <div className="flex min-w-0 flex-col divide-y divide-ui-line overflow-hidden rounded-panel border border-ui-line bg-ui-panel">
        {children}
      </div>
      {note && <p className="px-1 text-xs text-ui-fg-muted">{note}</p>}
    </div>
  );
}

function Item({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex min-w-0 flex-col gap-2 px-3 py-3', className)}>{children}</div>;
}

function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-ui-fg">{label}</span>
        {hint && <span className="text-xs text-ui-fg-muted wrap-anywhere">{hint}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';
const PILL: Record<Tone, string> = {
  success: 'bg-ui-tool-green text-ui-tool-green-fg',
  warning: 'bg-ui-tool-orange text-ui-tool-orange-fg',
  danger: 'bg-ui-danger-soft text-ui-danger-fg',
  neutral: 'bg-ui-field text-ui-fg-muted',
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        PILL[tone],
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{children}</span>
    </span>
  );
}

type Page = 'general' | 'agents' | 'library' | 'about';

const PAGES: Record<
  Page,
  { icon: LucideIcon; tone: string; tab: MessageKey; title: MessageKey; about: MessageKey }
> = {
  general: {
    icon: SlidersHorizontal,
    tone: 'bg-ui-tool-blue text-ui-tool-blue-fg',
    tab: 'settings.generalTab',
    title: 'settings.generalTitle',
    about: 'settings.generalAbout',
  },
  agents: {
    icon: Sparkles,
    tone: 'bg-ui-tool-violet text-ui-tool-violet-fg',
    tab: 'settings.agentsTab',
    title: 'settings.agentsTitle',
    about: 'settings.agentsAbout',
  },
  library: {
    icon: Library,
    tone: 'bg-ui-tool-pink text-ui-tool-pink-fg',
    tab: 'settings.libraryTab',
    title: 'settings.libraryTitle',
    about: 'settings.libraryAbout',
  },
  about: {
    icon: Info,
    tone: 'bg-ui-tool-teal text-ui-tool-teal-fg',
    tab: 'settings.aboutTab',
    title: 'settings.aboutTitle',
    about: 'settings.aboutAbout',
  },
};

function PageHeader({ page }: { page: Page }) {
  const t = useT();
  const { icon, tone, title, about } = PAGES[page];
  return (
    <div className="flex items-start gap-3">
      <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-panel', tone)}>
        <Icon icon={icon} size="md" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-md font-semibold text-ui-fg">{t(title)}</h3>
        <p className="text-xs text-ui-fg-muted">{t(about)}</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- general */

function General() {
  const t = useT();
  const [lang, setLang] = useLang();
  const theme = useTheme();
  return (
    <>
      <Group title={t('settings.appearance')}>
        <Item>
          <span className="text-sm">{t('settings.theme')}</span>
          <SegmentedControl<ThemeChoice>
            aria-label={t('settings.theme')}
            fill
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'system', label: t('settings.themeSystem'), icon: Monitor },
              { value: 'light', label: t('settings.themeLight'), icon: Sun },
              { value: 'dark', label: t('settings.themeDark'), icon: Moon },
            ]}
          />
        </Item>
        <Row label={t('settings.language')} hint={t('settings.languageHint')}>
          <Select
            aria-label={t('settings.language')}
            size="sm"
            className="w-36"
            value={lang}
            onValueChange={setLang}
            options={CONTENT_LANGUAGES.map((one) => ({
              value: one,
              label: LANGUAGE_NAMES[one].native,
            }))}
          />
        </Row>
      </Group>
    </>
  );
}

/* ---------------------------------------------------------------- agents */

function Programs({ status }: { status?: ServerStatus }) {
  const t = useT();
  if (!status) return <Skeleton className="h-24 w-full rounded-panel" />;
  return (
    <Group title={t('settings.programs')} note={t('settings.programsNote')}>
      {status.programs.map((program) => {
        const known = program.name === 'claude' || program.name === 'codex';
        return (
          <Row
            key={program.name}
            label={
              <span className="inline-flex items-center gap-2">
                {known && <AgentMark program={program.name as 'claude' | 'codex'} />}
                {known ? programName(program.name as 'claude' | 'codex') : program.name}
                {program.version && (
                  <span dir="ltr" className="text-xs text-ui-fg-muted">
                    {program.version}
                  </span>
                )}
              </span>
            }
            hint={program.note ?? program.path ?? undefined}
          >
            <StatusPill tone={program.ready ? 'success' : program.path ? 'warning' : 'danger'}>
              {program.ready
                ? t('settings.programReady')
                : program.path
                  ? t('settings.programSignIn')
                  : t('settings.programMissing')}
            </StatusPill>
          </Row>
        );
      })}
    </Group>
  );
}

function Agents({ status }: { status?: ServerStatus }) {
  const t = useT();
  const saved = useStudio((studio) => studio.settings);
  const [draft, setDraft] = useState<StudioSettings>();
  const [error, setError] = useState<string>();
  const settings = draft ?? saved;
  const save = (next: StudioSettings) => {
    setDraft(next);
    setError(undefined);
    api.saveSettings(next).then(
      () => setDraft(undefined),
      (failure: unknown) => setError(message(failure)),
    );
  };
  if (!settings) {
    return <Skeleton className="h-48 w-full rounded-panel" />;
  }
  const choose = (role: AgentRole, choice: AgentChoice) =>
    save({ ...settings, agents: { ...settings.agents, [role]: choice } });
  return (
    <>
      {AGENT_ROLES.map((role) => (
        <Group key={role} title={t(ROLE[role].title)} note={t(ROLE[role].about)}>
          <Item>
            <AgentFields
              role={role}
              value={settings.agents[role]}
              onChange={(next) => choose(role, next)}
            />
          </Item>
        </Group>
      ))}
      <Group title={t('settings.review')} note={t('settings.reviewNote')}>
        <Row label={t('settings.reviewRounds')}>
          <Select
            aria-label={t('settings.reviewRounds')}
            size="sm"
            className="w-24"
            value={String(settings.reviewRounds)}
            onValueChange={(rounds) => save({ ...settings, reviewRounds: Number(rounds) })}
            options={['0', '1', '2', '3'].map((n) => ({
              value: n,
              label: n === '0' ? t('settings.none') : n,
            }))}
          />
        </Row>
      </Group>
      {error && (
        <p role="alert" className="text-xs text-ui-danger-fg" dir="auto">
          {error}
        </p>
      )}
      <Programs status={status} />
    </>
  );
}

/* ---------------------------------------------------------------- the library */

function Token({ status, onStatus }: { status?: ServerStatus; onStatus: () => void }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string>();
  const has = status?.library.token ?? false;
  const save = () =>
    void api.librarySettings(token).then(
      () => {
        setToken('');
        setError(undefined);
        setReplacing(false);
        onStatus();
      },
      (failure: unknown) => setError(message(failure)),
    );
  return (
    <Group title={t('settings.libraryConnection')} note={t('publish.tokenHelp')}>
      <Row
        label={t('settings.libraryAddress')}
        hint={<span dir="ltr">{status?.library.url ?? '…'}</span>}
      />
      <Row label={t('publish.tokenTitle')}>
        <StatusPill tone={has ? 'success' : 'warning'}>
          {has ? t('settings.tokenSaved') : t('settings.tokenMissing')}
        </StatusPill>
      </Row>
      {!has || replacing ? (
        <Item>
          <div className="flex gap-1.5">
            <Input
              type="password"
              dir="ltr"
              aria-label={t('publish.tokenTitle')}
              placeholder="slk_…"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button size="md" variant="primary" disabled={token.trim().length < 10} onClick={save}>
              {t('publish.save')}
            </Button>
          </div>
          {replacing && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                {t('publish.keepToken')}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-ui-danger-fg" dir="auto">
              {error}
            </p>
          )}
        </Item>
      ) : (
        <Item>
          <div>
            <Button size="sm" onClick={() => setReplacing(true)}>
              {t('publish.replaceToken')}
            </Button>
          </div>
        </Item>
      )}
    </Group>
  );
}

/**
 * The pictures of the published designs that the galleries show, drawn where the library lacks
 * them (src-tauri/src/gallery.rs): how many are missing, and drawing them.
 */
function GalleryPictures({ hasToken }: { hasToken: boolean }) {
  const t = useT();
  const [missing, setMissing] = useState<GalleryMissing>();
  const [drawn, setDrawn] = useState<GalleryDrawn>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const look = () =>
    api.galleryMissing().then(
      (found) => setMissing(found),
      (failure: unknown) => setError(message(failure)),
    );
  useEffect(() => void look(), []);
  const draw = () => {
    setBusy(true);
    setError(undefined);
    api
      .galleryDraw()
      .then(
        (done) => {
          setDrawn(done);
          return look();
        },
        (failure: unknown) => setError(message(failure)),
      )
      .finally(() => setBusy(false));
  };
  const sent = drawn?.uploads.filter((upload) => upload.status === 'published').length ?? 0;
  return (
    <Group title={t('publish.galleryTitle')} note={t('publish.galleryHelp')}>
      <Item>
        <p className="text-sm">
          {!missing
            ? '…'
            : missing.stale
              ? t('publish.galleryStale')
              : missing.slides
                ? t('publish.galleryMissing', {
                    slides: missing.slides,
                    designs: missing.designs ?? 0,
                  })
                : t('publish.galleryNone')}
        </p>
        {drawn && (
          <p className="text-xs text-ui-fg-muted">
            {t('settings.galleryDrawn', { count: drawn.uploads.length, published: sent })}
            {drawn.failed.length > 0 &&
              ` · ${t('publish.galleryFailed', { count: drawn.failed.length })}`}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-ui-danger-fg" dir="auto">
            {error}
          </p>
        )}
        <div>
          <Button
            size="sm"
            loading={busy}
            disabled={!hasToken || !(missing?.stale || missing?.slides)}
            onClick={draw}
          >
            {busy
              ? t('publish.galleryDrawing')
              : missing?.stale
                ? t('publish.galleryDrawStale')
                : t('publish.galleryDraw', { count: missing?.slides ?? 0 })}
          </Button>
        </div>
      </Item>
    </Group>
  );
}

/* ---------------------------------------------------------------- about */

function About() {
  const t = useT();
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    if (isTauri()) getVersion().then(setVersion, () => undefined);
  }, []);
  return (
    <Group>
      <Row label="Slidr Studio" hint={version ? <span dir="ltr">{version}</span> : undefined} />
      <Item>
        <p className="text-xs text-ui-fg-muted">{t('settings.aboutText')}</p>
      </Item>
    </Group>
  );
}

/* ---------------------------------------------------------------- the panel */

/** The studio's settings, as the app's: tiles of topics, each a page of groups. */
export function SettingsPanel({
  status,
  onStatus,
}: {
  status?: ServerStatus;
  onStatus: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<Page>('agents');
  return (
    <Tabs value={page} onValueChange={(value) => setPage(value as Page)} className="flex flex-col">
      <TabsTileList
        aria-label={t('settings.topics')}
        className="sticky top-0 z-10 border-b border-ui-line bg-ui-panel px-2 pb-2"
      >
        {(Object.keys(PAGES) as Page[]).map((id) => (
          <TabsTile key={id} value={id} icon={PAGES[id].icon} label={t(PAGES[id].tab)} />
        ))}
      </TabsTileList>
      {(Object.keys(PAGES) as Page[]).map((id) => (
        <TabsContent key={id} value={id} className="flex flex-col gap-6 px-4 pt-4 pb-8">
          <PageHeader page={id} />
          {id === 'general' && <General />}
          {id === 'agents' && <Agents status={status} />}
          {id === 'library' && (
            <>
              <Token status={status} onStatus={onStatus} />
              <GalleryPictures hasToken={status?.library.token ?? false} />
            </>
          )}
          {id === 'about' && <About />}
        </TabsContent>
      ))}
    </Tabs>
  );
}
