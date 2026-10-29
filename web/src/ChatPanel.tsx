import { CONTENT_LANGUAGES, LANGUAGE_NAMES } from '@slidr/model';
import {
  Button,
  Checkbox,
  cx,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Spinner,
  Textarea,
} from '@slidr/ui';
import {
  ArrowUp,
  CircleAlert,
  History,
  Languages as LanguagesIcon,
  Square,
  SquarePen,
  Trash2,
  X,
} from '@slidr/ui/icons';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AgentPicker } from './agents';
import {
  AGENT_ROLES,
  agentsOf,
  api,
  isRunning,
  useStudio,
  type AgentChoice,
  type AgentRole,
  type Agents,
  type Chat,
  type ChatKind,
  type ChatMessage,
  type Lang,
  type StudioRequest,
  type TemplateInfo,
  type Variant,
} from './api';
import { useLang, useT, type MessageKey } from './i18n';
import { kindInfo } from './kinds';
import { stateOf, type OutputState } from './outputs';
import { PanelHeader } from './Studio';
import { openChat, setUi, showOutputs, toggleSelected, useUi } from './ui';
import { outputName, STATE_LABEL } from './OutputCard';

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/* ---------------------------------------------------------------- the header */

/** The requests of a chat that are still at work: planning, or making their outputs. */
function useRunning(chat?: Chat) {
  const studio = useStudio();
  return studio.requests.filter(
    (request) =>
      chat !== undefined &&
      request.chatId === chat.id &&
      (request.status === 'planning' ||
        request.variantIds.some((vid) => studio.variants[vid] && isRunning(studio.variants[vid]))),
  );
}

function ChatHeader({ chat, chats }: { chat?: Chat; chats: Chat[] }) {
  const t = useT();
  const [lang] = useLang();
  const running = useRunning(chat);
  const when = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
  const newest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const stop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const remove = (one: Chat) => {
    if (!window.confirm(t('chat.deleteConfirm', { title: one.title }))) return;
    if (one.id === chat?.id) openChat(null);
    void api.deleteChat(one.id).catch((failure: unknown) => window.alert(message(failure)));
  };
  return (
    <PanelHeader title={chat?.title || t('chat.newChat')}>
      {running.length > 0 && (
        <IconButton
          icon={Square}
          size="sm"
          label={t('chat.stop')}
          data-testid="chat-stop"
          onClick={() => running.forEach((request) => void api.cancelRequest(request.id))}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton icon={History} size="sm" label={t('chat.history')} data-testid="history" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 max-w-80">
          <DropdownMenuLabel>{t('chat.historyHeading')}</DropdownMenuLabel>
          {newest.length === 0 && (
            <p className="px-2 pb-2 text-xs text-ui-fg-muted">{t('chat.historyEmpty')}</p>
          )}
          {newest.map((one) => (
            <DropdownMenuItem
              key={one.id}
              data-chat={one.id}
              // Room for the two lines: an item of a menu is as high as one.
              className={cx('min-h-11 pe-1', one.id === chat?.id && 'bg-ui-accent-soft')}
              onSelect={() => openChat(one.id)}
              hint={
                <button
                  type="button"
                  aria-label={t('chat.delete')}
                  title={t('chat.delete')}
                  className="inline-flex size-control-sm cursor-default items-center justify-center rounded-control text-ui-fg-muted hover:bg-ui-danger-soft hover:text-ui-danger-fg"
                  onPointerDown={stop}
                  onPointerUp={stop}
                  onClick={(event) => {
                    stop(event);
                    remove(one);
                  }}
                >
                  <Icon icon={Trash2} />
                </button>
              }
            >
              {/* Two lines: a long title is cut, and when it was said stays whole. */}
              <span className="flex min-w-0 flex-col items-start">
                <span dir="auto" className="max-w-full truncate">
                  {one.title || t('chat.untitled')}
                </span>
                <span className="text-xs text-ui-fg-muted">{when(one.updatedAt)}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {chat && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={SquarePen} onSelect={() => openChat(null)}>
                {t('chat.new')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton
        icon={SquarePen}
        size="sm"
        label={t('chat.new')}
        disabled={!chat}
        data-testid="chat-new"
        onClick={() => openChat(null)}
      />
    </PanelHeader>
  );
}

/* ---------------------------------------------------------------- the messages */

/** A pill naming an output; a click shows it among the outputs. */
function OutputPill({ variant, onRemove }: { variant: Variant; onRemove?: () => void }) {
  const t = useT();
  const [lang] = useLang();
  return (
    <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full bg-ui-accent-soft ps-2 pe-1 text-xs font-medium text-ui-accent-fg">
      <button
        type="button"
        className="min-w-0 cursor-default truncate"
        dir="auto"
        title={t('chat.showOutput')}
        onClick={() => showOutputs([variant.id])}
      >
        {outputName(variant, lang)}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={t('chat.unselect')}
          className="inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-full hover:bg-ui-accent-soft-hover"
          onClick={onRemove}
        >
          <Icon icon={X} size="sm" />
        </button>
      )}
    </span>
  );
}

function UserMessage({
  entry,
  variants,
}: {
  entry: ChatMessage;
  variants: Record<string, Variant>;
}) {
  const t = useT();
  const info = entry.kind && entry.kind !== 'auto' ? kindInfo(entry.kind) : undefined;
  const refs = (entry.refs ?? []).flatMap((id) => (variants[id] ? [variants[id]] : []));
  return (
    <div
      role="article"
      aria-label={t('chat.you')}
      className="ms-10 flex max-w-full flex-col gap-1.5 self-end rounded-panel bg-ui-accent-soft px-3 py-2 text-ui-fg"
    >
      {info && refs.length === 0 && (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-ui-accent-fg">
          <Icon icon={info.icon} size="sm" />
          {t(info.title)}
        </span>
      )}
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {refs.map((variant) => (
            <OutputPill key={variant.id} variant={variant} />
          ))}
        </div>
      )}
      {entry.text && (
        <div dir="auto" className="text-start text-md leading-6 whitespace-pre-wrap wrap-anywhere">
          {entry.text}
        </div>
      )}
    </div>
  );
}

function Working({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ui-fg-muted">
      <Spinner />
      <span>{children}</span>
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-panel bg-ui-danger-soft px-3 py-2 text-sm text-ui-danger-fg"
    >
      <Icon icon={CircleAlert} className="mt-0.5 shrink-0" />
      <span dir="auto" className="min-w-0 wrap-anywhere">
        {children}
      </span>
    </div>
  );
}

/** The order the counts of a request's outputs are said in. */
const COUNTED: OutputState[] = [
  'working',
  'awaitingMaster',
  'awaitingPublish',
  'publishing',
  'waitsInLibrary',
  'published',
  'changedSincePublished',
  'failsContract',
  'publishFailed',
  'failed',
  'cancelled',
];

/** What a request made so far: how many, where they stand, and a way to see them. */
function Outputs({ request, variants }: { request: StudioRequest; variants: Variant[] }) {
  const t = useT();
  const shown = variants.filter((variant) => !variant.discarded);
  if (shown.length === 0) return null;
  const counts = new Map<OutputState, number>();
  for (const variant of shown) {
    const state = stateOf(variant);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const kind = request.kind === 'template' ? 'template' : 'design';
  return (
    <div className="flex flex-col gap-2 rounded-control border border-ui-line px-3 py-2">
      <button
        type="button"
        className="flex cursor-default items-center gap-2 text-start text-sm font-medium hover:text-ui-accent-fg"
        onClick={() => showOutputs(shown.map((variant) => variant.id))}
      >
        <Icon icon={kindInfo(kind).icon} className="text-ui-fg-muted" />
        <span className="min-w-0 flex-1">
          {kind === 'template'
            ? t('chat.samplesCount', { count: shown.length })
            : t('chat.designsCount', { count: shown.length })}
        </span>
        <span className="text-xs font-normal text-ui-accent-fg">{t('chat.show')}</span>
      </button>
      <p className="text-xs text-ui-fg-muted">
        {COUNTED.filter((state) => counts.has(state))
          .map((state) => `${counts.get(state)} ${t(STATE_LABEL[state])}`)
          .join(' · ')}
      </p>
      {kind === 'design' && request.status !== 'planning' && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => void api.more(request.id, 2)}>
            {t('chat.moreDesigns')}
          </Button>
        </div>
      )}
    </div>
  );
}

const READING: Record<string, MessageKey> = {
  auto: 'chat.reading',
  template: 'chat.preparingTemplate',
  design: 'chat.planning',
};

/** The studio's side of a request: reading and planning it, its answer, what it made. */
function RequestTurn({ request, variants }: { request: StudioRequest; variants: Variant[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2" data-request={request.id}>
      {request.route?.reason && (
        <p dir="auto" className="text-md leading-6 text-ui-fg">
          {request.route.reason}
        </p>
      )}
      {request.status === 'planning' && (
        <Working>
          {request.kind === 'design' && request.count
            ? t('chat.planningMore')
            : t(READING[request.kind ?? 'design'] ?? 'chat.planning')}
        </Working>
      )}
      {request.status === 'failed' && request.error && <Problem>{request.error}</Problem>}
      {request.status === 'cancelled' && (
        <p className="text-sm text-ui-fg-muted">{t('chat.stopped')}</p>
      )}
      <Outputs request={request} variants={variants} />
    </div>
  );
}

/** The studio's side of a change asked for: where each output stands, and what was refused. */
function ChangeTurn({
  entry,
  variants,
}: {
  entry: ChatMessage;
  variants: Record<string, Variant>;
}) {
  const t = useT();
  const [lang] = useLang();
  const refs = (entry.refs ?? []).flatMap((id) => (variants[id] ? [variants[id]] : []));
  const refused = new Set((entry.errors ?? []).map((error) => error.variantId));
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-ui-fg-muted">
        {t('chat.changeSent', { count: refs.length - refused.size })}
      </p>
      {refs
        .filter((variant) => !refused.has(variant.id))
        .map((variant) => (
          <button
            type="button"
            key={variant.id}
            onClick={() => showOutputs([variant.id])}
            className="flex cursor-default items-center gap-2 text-start text-sm hover:text-ui-accent-fg"
          >
            {isRunning(variant) ? <Spinner /> : <span className="size-4" />}
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {outputName(variant, lang)}
            </span>
            <span className="text-xs text-ui-fg-muted">{t(STATE_LABEL[stateOf(variant)])}</span>
          </button>
        ))}
      {(entry.errors ?? []).map((error, i) => {
        const about = error.variantId ? variants[error.variantId] : undefined;
        return (
          <Problem key={i}>
            {about ? `${outputName(about, lang)}: ` : ''}
            {error.error}
          </Problem>
        );
      })}
    </div>
  );
}

function Messages({ chat }: { chat: Chat }) {
  const studio = useStudio();
  const end = useRef<HTMLDivElement>(null);
  const length = chat.messages.length;
  useEffect(() => {
    // Braces: a browser's scrollIntoView may answer a promise, which an effect must not return.
    end.current?.scrollIntoView({ block: 'end' });
  }, [length, chat.id]);
  const byId = useMemo(
    () => Object.fromEntries(studio.requests.map((request) => [request.id, request])),
    [studio.requests],
  );
  const variantsOf = (request: StudioRequest) =>
    request.variantIds.flatMap((vid) => (studio.variants[vid] ? [studio.variants[vid]] : []));
  return (
    <div className="flex flex-col gap-4 px-4 pt-1 pb-3">
      {chat.messages.map((entry) =>
        entry.role === 'user' ? (
          <div key={entry.id} className="flex flex-col gap-3">
            <UserMessage entry={entry} variants={studio.variants} />
            {(entry.requestIds ?? []).map((rid) =>
              byId[rid] ? (
                <RequestTurn key={rid} request={byId[rid]} variants={variantsOf(byId[rid])} />
              ) : null,
            )}
            {(entry.refs?.length ?? 0) > 0 && (
              <ChangeTurn entry={entry} variants={studio.variants} />
            )}
          </div>
        ) : (
          <p key={entry.id} dir="auto" className="text-md leading-6 whitespace-pre-wrap">
            {entry.text}
          </p>
        ),
      )}
      <div ref={end} />
    </div>
  );
}

/* ---------------------------------------------------------------- the empty chat */

const EMPTY: Partial<Record<ChatKind, MessageKey>> = {
  auto: 'chat.emptyAuto',
  design: 'chat.emptyDesign',
  template: 'chat.emptyTemplate',
};

const SUGGESTIONS: Partial<Record<ChatKind, MessageKey[]>> = {
  auto: ['chat.example.translate', 'chat.example.invitation', 'chat.example.webinar'],
  design: ['chat.example.invitation', 'chat.example.webinar', 'chat.example.thumbnail'],
  template: ['chat.example.rewrite'],
};

function Empty({ kind, onSuggest }: { kind: ChatKind; onSuggest: (text: string) => void }) {
  const t = useT();
  const info = kindInfo(kind);
  const about = EMPTY[kind];
  return (
    <div className="flex flex-col items-center gap-2 px-4">
      <EmptyState
        icon={info.icon}
        title={kind === 'auto' ? t('chat.emptyTitle') : t(info.title)}
        description={about ? t(about) : undefined}
      />
      <div className="flex flex-wrap justify-center gap-1.5">
        {(SUGGESTIONS[kind] ?? []).map((key) => (
          <button
            type="button"
            key={key}
            onClick={() => onSuggest(t(key))}
            className="cursor-default rounded-full border border-ui-line px-3 py-1 text-start text-xs text-ui-fg-muted hover:border-ui-line-strong hover:bg-ui-hover hover:text-ui-fg"
          >
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the composer */

/** The languages to write a template's sample in: those it lacks, unless chosen otherwise. */
function SampleLanguages({
  template,
  chosen,
  onChange,
}: {
  template: TemplateInfo;
  chosen: Lang[];
  onChange: (langs: Lang[]) => void;
}) {
  const t = useT();
  const has = new Set(template.languages);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" icon={LanguagesIcon} className="text-ui-fg-muted">
          {t('chat.languagesCount', { count: chosen.length })}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-popover">
        <div className="flex flex-col gap-3">
          <span className="text-sm font-semibold">{t('chat.sampleLanguages')}</span>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {CONTENT_LANGUAGES.map((lang) => (
              <Checkbox
                key={lang}
                checked={chosen.includes(lang)}
                onCheckedChange={(on) =>
                  onChange(
                    on
                      ? CONTENT_LANGUAGES.filter((one) => one === lang || chosen.includes(one))
                      : chosen.filter((one) => one !== lang),
                  )
                }
                label={`${LANGUAGE_NAMES[lang].native}${has.has(lang) ? ' ✓' : ''}`}
              />
            ))}
          </div>
          <p className="text-xs text-ui-fg-muted">{t('chat.sampleLanguagesNote')}</p>
          <div className="flex gap-1">
            <Button size="sm" onClick={() => onChange(template.missing)}>
              {t('chat.allMissing', { count: template.missing.length })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              {t('chat.clear')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const COUNTS = ['', '1', '2', '3', '4', '6', '8', '10', '12'] as const;

function Composer({ chat }: { chat?: Chat }) {
  const t = useT();
  const [lang] = useLang();
  const studio = useStudio();
  const ui = useUi();
  const field = useRef<HTMLTextAreaElement>(null);
  const text = ui.draft;
  const setText = (draft: string) => setUi({ draft });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [count, setCount] = useState<(typeof COUNTS)[number]>('');
  const [templates, setTemplates] = useState<TemplateInfo[]>();
  const [templateId, setTemplateId] = useState('');
  const [sampleLangs, setSampleLangs] = useState<Lang[]>([]);
  const info = kindInfo(ui.kind);
  const refs = ui.selected.filter((vid) => studio.variants[vid]);
  const editing = refs.length > 0;

  useEffect(() => {
    field.current?.focus();
  }, [ui.focusComposer]);
  useEffect(() => {
    if (ui.kind !== 'template' || templates) return;
    api.templates().then(
      ({ templates: read }) => setTemplates(read),
      (failure: unknown) => setError(message(failure)),
    );
  }, [ui.kind, templates]);
  const template = templates?.find((one) => one.id === templateId);

  const own: Partial<Agents> = chat ? (chat.agents ?? {}) : (ui.pendingAgents ?? {});
  const agents = agentsOf(studio.settings, { ...(chat ?? emptyChat), agents: own });
  const chooseAgent = (role: AgentRole, choice: AgentChoice | null) => {
    const next: Partial<Agents> = { ...own };
    if (choice) next[role] = choice;
    else delete next[role];
    const value = Object.keys(next).length ? next : null;
    if (chat) {
      api.chatAgents(chat.id, value).catch((failure: unknown) => setError(message(failure)));
    } else {
      setUi({ pendingAgents: value });
    }
  };

  const ready =
    !busy &&
    (editing
      ? text.trim().length >= 2
      : info.makeable &&
        (ui.kind === 'template'
          ? Boolean(template) && sampleLangs.length > 0
          : text.trim().length >= 3));

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const sent = await api.send({
        ...(chat ? { chatId: chat.id } : {}),
        text: text.trim(),
        kind: ui.kind,
        ...(editing ? { refs } : {}),
        ...(!editing && ui.kind === 'design' && count ? { count: Number(count) } : {}),
        ...(!editing && ui.kind === 'template' ? { templateId, languages: sampleLangs } : {}),
      });
      if (!chat) {
        const pending = ui.pendingAgents;
        setUi({ chatId: sent.id, pendingAgents: null });
        if (pending) await api.chatAgents(sent.id, pending);
      }
      setText('');
      setUi({ selected: [] });
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const placeholder: MessageKey = editing
    ? 'chat.placeholderChange'
    : ui.kind === 'template'
      ? 'chat.placeholderTemplate'
      : ui.kind === 'design'
        ? 'chat.placeholderDesign'
        : 'chat.placeholderAuto';

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-4 pt-2 pb-4">
      {editing ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ui-fg-muted">
          <span className="shrink-0">{t('chat.about')}</span>
          {refs.slice(0, 3).map((vid) => (
            <OutputPill
              key={vid}
              variant={studio.variants[vid]!}
              onRemove={() => toggleSelected(vid)}
            />
          ))}
          {refs.length > 3 && (
            <span className="font-medium text-ui-accent-fg">
              {t('chat.andMore', { count: refs.length - 3 })}
            </span>
          )}
          <button
            type="button"
            className="cursor-default text-ui-fg-muted underline-offset-2 hover:text-ui-fg hover:underline"
            onClick={() => setUi({ selected: [] })}
          >
            {t('chat.clearSelection')}
          </button>
        </div>
      ) : (
        ui.kind !== 'auto' && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ui-fg-muted">
            <span className="shrink-0">{t('chat.making')}</span>
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-ui-accent-soft ps-2 pe-1 font-medium text-ui-accent-fg">
              <Icon icon={info.icon} className="-ms-0.5" />
              {t(info.title)}
              <button
                type="button"
                aria-label={t('chat.anyKind')}
                title={t('chat.anyKind')}
                className="inline-flex size-4 cursor-default items-center justify-center rounded-full hover:bg-ui-accent-soft-hover"
                onClick={() => setUi({ kind: 'auto' })}
              >
                <Icon icon={X} size="sm" />
              </button>
            </span>
          </div>
        )
      )}
      {!editing && !info.makeable && (
        <div
          role="note"
          className="rounded-panel border border-ui-line bg-ui-field px-3 py-2 text-xs text-ui-fg-muted"
        >
          {t('chat.notMakeable', { kind: t(info.title) })}
        </div>
      )}
      {!editing && info.makeable && ui.kind === 'design' && (
        <div className="flex items-center gap-2 text-xs text-ui-fg-muted">
          <span>{t('chat.howMany')}</span>
          <Select
            aria-label={t('chat.howMany')}
            size="sm"
            variant="ghost"
            value={count || 'asked'}
            onValueChange={(value) => setCount(value === 'asked' ? '' : (value as typeof count))}
            options={COUNTS.map((n) => ({
              value: n || 'asked',
              label: n || t('chat.asAsked'),
            }))}
          />
          <span className="min-w-0 flex-1 truncate">{t('chat.allLanguagesNote')}</span>
        </div>
      )}
      {!editing && ui.kind === 'template' && (
        <div className="flex min-w-0 items-center gap-1">
          <Select
            aria-label={t('chat.template')}
            size="sm"
            className="min-w-0 flex-1"
            value={templateId || null}
            placeholder={templates ? t('chat.chooseTemplate') : t('chat.loadingTemplates')}
            onValueChange={(id) => {
              setTemplateId(id);
              setSampleLangs(templates?.find((one) => one.id === id)?.missing ?? []);
            }}
            options={(templates ?? []).map((one) => ({
              value: one.id,
              label: `${lang === 'he' ? one.name.he : one.name.en} · ${
                one.missing.length
                  ? t('chat.templateMissing', { count: one.missing.length })
                  : t('chat.templateComplete')
              }`,
            }))}
          />
          {template && (
            <SampleLanguages template={template} chosen={sampleLangs} onChange={setSampleLangs} />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-ui-danger-fg" dir="auto">
          {error}
        </p>
      )}
      <Textarea
        ref={field}
        dir={text ? 'auto' : undefined}
        value={text}
        aria-label={t('chat.message')}
        placeholder={t(placeholder)}
        data-testid="chat-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        footer={
          <div className="flex min-w-0 items-center gap-0.5">
            {/* The agents of this chat; the buttons that send and stop keep their room. */}
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
              {agents &&
                AGENT_ROLES.map((role) => (
                  <AgentPicker
                    key={role}
                    role={role}
                    value={agents[role]}
                    own={own[role] !== undefined}
                    onChange={(choice) => chooseAgent(role, choice)}
                    onReset={() => chooseAgent(role, null)}
                  />
                ))}
            </div>
            <IconButton
              icon={ArrowUp}
              variant="primary"
              size="sm"
              label={t('chat.send')}
              shortcut="Enter"
              loading={busy}
              disabled={!ready}
              data-testid="chat-send"
              onClick={() => void send()}
            />
          </div>
        }
      />
    </div>
  );
}

const emptyChat: Chat = { id: '', title: '', createdAt: 0, updatedAt: 0, messages: [] };

/* ---------------------------------------------------------------- the panel */

/** The chat, as the app's: its title bar and history, the messages, and the composer. */
export function ChatPanel() {
  const studio = useStudio();
  const ui = useUi();
  const chat = studio.chats.find((one) => one.id === ui.chatId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader chat={chat} chats={studio.chats} />
      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        {chat && chat.messages.length > 0 ? (
          <Messages chat={chat} />
        ) : (
          <Empty
            kind={ui.kind}
            onSuggest={(draft) => setUi((now) => ({ draft, focusComposer: now.focusComposer + 1 }))}
          />
        )}
      </div>
      <Composer chat={chat} />
    </div>
  );
}
