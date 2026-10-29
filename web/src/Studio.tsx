import { languageDir } from '@slidr/model';
import { cx, IconButton, Icon, Tooltip, UiProvider } from '@slidr/ui';
import { BookOpen, PanelLeft, Settings as SettingsIcon, type LucideIcon } from '@slidr/ui/icons';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { api, isRunning, isTemplate, onOpen, useStudio, type ServerStatus } from './api';
import { ChatPanel } from './ChatPanel';
import { DisplayPanel } from './DisplayPanel';
import { useLang, useT } from './i18n';
import { KINDS } from './kinds';
import { awaitsApproval, isPublished } from './outputs';
import { SettingsPanel } from './SettingsPanel';
import { TemplateVariantDetail } from './TemplateVariantDetail';
import { chooseKind, openChat, requestedTab, setUi, toggleSettings, useUi } from './ui';
import { VariantDetail } from './VariantDetail';

/**
 * Slidr Library (github.com/slidrhq/library), where the studio's published work can be seen as
 * every installed app reads it (`VITE_SLIDR_LIBRARY_URL`). It opens in the system's browser.
 */
const LIBRARY_URL =
  (import.meta.env.VITE_SLIDR_LIBRARY_URL as string | undefined) ??
  'https://library.slidr.workers.dev/';

/* ---------------------------------------------------------------- the title bar */

/** The spark, a four-pointed star around (25.5, 11) on the mark's 32 grid. */
const SPARK =
  'M25.5 5.5Q26.38 10.12 31 11Q26.38 11.88 25.5 16.5Q24.62 11.88 20 11Q24.62 10.12 25.5 5.5Z';

/** The Slidr mark, as the app's title bar draws it (`shell/SlidrMark.tsx`). */
function SlidrMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <mask id="studio-mark" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="white" />
        <path d={SPARK} stroke="black" strokeWidth="2.4" strokeLinejoin="round" />
      </mask>
      <g mask="url(#studio-mark)">
        <rect x="3" y="6" width="18" height="13" rx="2.5" className="fill-ui-header-fg/50" />
        <rect x="7" y="12" width="20" height="14" rx="3" className="fill-ui-header-fg" />
        <rect x="10" y="16" width="9" height="2.5" rx="1.25" className="fill-ui-header-middle" />
        <rect x="10" y="20.5" width="6" height="2" rx="1" className="fill-ui-header-middle/45" />
      </g>
      <path d={SPARK} className="fill-ui-header-spark" />
    </svg>
  );
}

/** Claude Code and the Codex CLI: found and signed in, or what is missing. */
function Programs({ status }: { status?: ServerStatus }) {
  if (!status) return null;
  return (
    <div className="flex items-center gap-1.5">
      {status.programs.map((program) => (
        <Tooltip
          key={program.name}
          content={[program.path, program.version, program.note].filter(Boolean).join(' · ')}
        >
          <span
            className="inline-flex h-6 items-center gap-1.5 rounded-full bg-ui-header-hover px-2.5 text-xs font-medium"
            data-program={program.name}
          >
            <span
              aria-hidden
              className={cx(
                'size-1.5 rounded-full',
                program.ready ? 'bg-ui-header-spark' : 'bg-ui-header-fg/40',
              )}
            />
            {program.name}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function TitleBar({ status }: { status?: ServerStatus }) {
  const t = useT();
  const connected = useStudio((studio) => studio.connected);
  return (
    <header className="editor-header relative flex h-titlebar shrink-0 items-center gap-3 px-4">
      {/* The mark and the name are one Latin logo: the mark leads it in Hebrew too. */}
      <span dir="ltr" className="flex shrink-0 items-center gap-2">
        <SlidrMark className="size-8" />
        <span className="text-header font-bold tracking-tight">Slidr Studio</span>
      </span>
      <span aria-hidden className="h-5 w-px shrink-0 bg-ui-header-line" />
      <span className="min-w-0 flex-1 truncate text-sm opacity-90">{t('shell.subtitle')}</span>
      {!connected && (
        <span className="inline-flex h-6 items-center rounded-full bg-ui-danger px-2.5 text-xs font-medium">
          {t('shell.disconnected')}
        </span>
      )}
      <Programs status={status} />
      <a
        href={LIBRARY_URL}
        target="slidr-library"
        className="header-button inline-flex h-control items-center gap-1.5 rounded-control px-2.5 text-sm font-medium"
        title={t('shell.libraryTitle')}
      >
        <Icon icon={BookOpen} />
        {t('shell.library')}
      </a>
    </header>
  );
}

/* ---------------------------------------------------------------- the rail */

function RailButton({
  icon,
  label,
  caption,
  active,
  onClick,
  muted,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  caption: string;
  active: boolean;
  onClick: () => void;
  /** The library takes none of it yet: shown, quieter. */
  muted?: boolean;
  testId: string;
}) {
  return (
    <Tooltip content={label} side="end">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        data-rail={testId}
        onClick={onClick}
        className={cx(
          'inline-flex w-17 shrink-0 cursor-default flex-col items-center justify-center gap-1 rounded-control px-0.5 py-2 transition-colors',
          active
            ? 'bg-ui-accent-soft text-ui-accent-fg'
            : 'text-ui-fg-muted hover:bg-ui-hover hover:text-ui-fg active:bg-ui-pressed',
          muted && !active && 'opacity-70',
        )}
      >
        <Icon icon={icon} size="lg" />
        <span className="w-full truncate text-center text-2xs font-medium">{caption}</span>
      </button>
    </Tooltip>
  );
}

/** The Activity Bar of the app, as a list of what the studio makes: the next message's kind. */
function Rail() {
  const t = useT();
  const panel = useUi((ui) => ui.panel);
  const kind = useUi((ui) => ui.kind);
  return (
    <nav
      aria-label={t('rail.label')}
      className="flex w-activitybar shrink-0 flex-col items-center gap-3 overflow-y-auto border-e border-ui-line bg-ui-chrome py-3"
    >
      <div className="flex shrink-0 flex-col items-center gap-1">
        {KINDS.map((info) => (
          <RailButton
            key={info.kind}
            testId={info.kind}
            icon={info.icon}
            label={t(info.title)}
            caption={t(info.caption)}
            muted={!info.makeable}
            active={panel === 'chat' && kind === info.kind}
            onClick={() => chooseKind(info.kind)}
          />
        ))}
      </div>
      <div className="flex-1" />
      <div className="flex shrink-0 flex-col items-center gap-1">
        <RailButton
          testId="settings"
          icon={SettingsIcon}
          label={t('settings.title')}
          caption={t('rail.settings')}
          active={panel === 'settings'}
          onClick={toggleSettings}
        />
      </div>
    </nav>
  );
}

/* ---------------------------------------------------------------- the middle panel */

/** The panel's width before it is dragged: 360 at 1920, 320 at 1366 (the app's `layout.ts`). */
function defaultWidth(windowWidth: number) {
  const share = Math.min(Math.max((windowWidth - 1366) / (1920 - 1366), 0), 1);
  return Math.round(320 + share * 40);
}
const MIN_WIDTH = 300;
const MAX_SHARE = 0.45;

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function Splitter({
  width,
  windowWidth,
  onDragging,
}: {
  width: number;
  windowWidth: number;
  onDragging: (dragging: boolean) => void;
}) {
  const t = useT();
  const [lang] = useLang();
  const [start, setStart] = useState<{ x: number; width: number } | null>(null);
  const max = Math.floor(windowWidth * MAX_SHARE);
  // The panel grows towards the outputs: right in LTR, left in RTL.
  const sign = languageDir(lang) === 'rtl' ? -1 : 1;
  const resize = (next: number) =>
    setUi({ panelShare: Math.min(Math.max(next, MIN_WIDTH), max) / windowWidth });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setStart({ x: event.clientX, width });
    onDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start) resize(start.width + sign * (event.clientX - start.x));
  };
  const onPointerUp = () => {
    setStart(null);
    onDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: sign * 16, ArrowLeft: -sign * 16 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    resize(width + step);
  };
  return (
    <div className="relative z-10 w-0 shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('shell.resize')}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setUi({ panelShare: null })}
        className={cx(
          'group absolute inset-y-0 -start-1 w-2 cursor-col-resize focus-visible:outline-none',
          'after:absolute after:inset-y-0 after:start-0.75 after:w-0.5 after:transition-colors',
          'hover:after:bg-ui-accent focus-visible:after:bg-ui-focus active:after:bg-ui-accent',
        )}
      />
    </div>
  );
}

/** A panel's title bar, as the app's (`PanelHeader`): its title, and its own buttons. */
export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <h2 dir="auto" className="min-w-0 flex-1 animate-fade-in truncate px-1 text-md font-semibold">
        {title}
      </h2>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function MiddlePanel({ status, onStatus }: { status?: ServerStatus; onStatus: () => void }) {
  const panel = useUi((ui) => ui.panel);
  const panelShare = useUi((ui) => ui.panelShare);
  const t = useT();
  const windowWidth = useWindowWidth();
  const [dragging, setDragging] = useState(false);
  const max = Math.floor(windowWidth * MAX_SHARE);
  const wanted = panelShare === null ? defaultWidth(windowWidth) : panelShare * windowWidth;
  const width = Math.round(Math.min(Math.max(wanted, MIN_WIDTH), max));
  return (
    <>
      <aside
        data-panel={panel}
        style={{ '--panel-width': `${width}px` } as CSSProperties}
        className={cx(
          'relative w-(--panel-width) shrink-0 overflow-hidden border-e border-ui-line bg-ui-panel',
          !dragging && 'transition-[width] duration-(--duration-slow) ease-standard',
        )}
      >
        <div className="flex h-full w-(--panel-width) flex-col">
          {panel === 'settings' ? (
            <>
              <PanelHeader title={t('settings.title')}>
                <IconButton
                  icon={PanelLeft}
                  mirror
                  size="sm"
                  label={t('settings.backToChat')}
                  onClick={toggleSettings}
                />
              </PanelHeader>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SettingsPanel status={status} onStatus={onStatus} />
              </div>
            </>
          ) : (
            <ChatPanel />
          )}
        </div>
      </aside>
      <Splitter width={width} windowWidth={windowWidth} onDragging={setDragging} />
    </>
  );
}

/* ---------------------------------------------------------------- the status bar */

function StatusBar() {
  const t = useT();
  const all = useStudio((studio) => studio.variants);
  const requests = useStudio((studio) => studio.requests);
  const connected = useStudio((studio) => studio.connected);
  const variants = Object.values(all).filter((variant) => !variant.discarded);
  const running =
    variants.filter(isRunning).length + requests.filter((r) => r.status === 'planning').length;
  const waiting = variants.filter(awaitsApproval).length;
  const published = variants.filter(isPublished).length;
  const item = (dot: string, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cx('size-1.5 rounded-full', dot)} />
      {text}
    </span>
  );
  return (
    <footer className="flex h-statusbar shrink-0 items-center gap-4 border-t border-ui-line bg-ui-chrome px-3 text-xs text-ui-fg-muted">
      {item(running ? 'bg-ui-accent' : 'bg-ui-fg-subtle', t('shell.running', { count: running }))}
      {item(
        waiting ? 'bg-ui-warning-fg' : 'bg-ui-fg-subtle',
        t('shell.awaiting', { count: waiting }),
      )}
      {item('bg-ui-success-fg', t('shell.published', { count: published }))}
      <span className="flex-1" />
      {!connected && <span className="text-ui-danger-fg">{t('shell.disconnected')}</span>}
    </footer>
  );
}

/* ---------------------------------------------------------------- the studio */

/** Opens what Slidr Library asks for, and a new chat in place of one another window deleted. */
function Follow() {
  const requests = useStudio((studio) => studio.requests);
  const chats = useStudio((studio) => studio.chats);
  const loaded = useStudio((studio) => studio.loaded);
  const chatId = useUi((ui) => ui.chatId);
  const detail = useUi((ui) => ui.detail);

  // Slidr Library opens a request and a variant here: the chat it was asked in, and the variant.
  const openRequest = useCallback(
    (rid: string | null | undefined, vid: string | null | undefined) => {
      const request = rid ? requests.find((one) => one.id === rid) : undefined;
      if (request?.chatId) openChat(request.chatId);
      if (vid) setUi({ detail: vid });
    },
    [requests],
  );
  useEffect(() => onOpen((open) => openRequest(open.tab, open.v)), [openRequest]);
  // Once, as the studio opens on an address of Slidr Library's (`#tab=<rid>&v=<vid>`).
  const tabDone = useRef(!requestedTab);
  useEffect(() => {
    if (tabDone.current || !loaded) return;
    tabDone.current = true;
    openRequest(requestedTab, detail);
  }, [loaded, openRequest, detail]);

  // A chat another window deleted: a new one in its place.
  useEffect(() => {
    if (loaded && chatId && !chats.some((chat) => chat.id === chatId)) {
      openChat(null);
    }
  }, [loaded, chats, chatId]);

  return null;
}

/** The output open up close. */
function Detail() {
  const id = useUi((ui) => ui.detail);
  const detail = useStudio((studio) => (id ? studio.variants[id] : undefined));
  if (!detail) return null;
  const close = () => setUi({ detail: null });
  return isTemplate(detail) ? (
    <TemplateVariantDetail key={detail.id} variant={detail} onClose={close} />
  ) : (
    <VariantDetail key={detail.id} variant={detail} onClose={close} />
  );
}

/**
 * The studio, laid out as the app is: the rail of what it makes, the chat that asks for it (or
 * the settings), and the outputs, which the person selects, asks to change in the chat, and
 * approves.
 *
 * It reads neither store itself: what it drew again would draw everything again, at every key
 * of the composer and every line of a working variant's log. Each part reads its own.
 */
export function Studio() {
  const [lang] = useLang();
  const [status, setStatus] = useState<ServerStatus>();

  const refreshStatus = useCallback(() => {
    api.status().then(setStatus, () => undefined);
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  return (
    <UiProvider dir={languageDir(lang)}>
      <div className="flex h-full flex-col bg-ui-chrome text-ui-fg">
        <TitleBar status={status} />
        <div className="flex min-h-0 flex-1">
          <Rail />
          <MiddlePanel status={status} onStatus={refreshStatus} />
          <DisplayPanel />
        </div>
        <StatusBar />
      </div>
      <Follow />
      <Detail />
    </UiProvider>
  );
}
