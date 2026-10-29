/**
 * The three agents of the studio, as the app shows its own (`agent/harnessLook.ts`,
 * `ai/ModelPicker.tsx`): a mark for each program, its model and effort, and the picker the
 * composer has for each role. The design agent makes the English master, its names and tags;
 * the images agent the pictures; the translation agent the other languages, their tags, and the
 * template samples. The settings choose them; a chat may choose its own.
 */
import {
  Button,
  cx,
  Icon,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
} from '@slidr/ui';
import { ImageIcon, Languages, Palette, type LucideIcon } from '@slidr/ui/icons';
import type { AgentChoice, AgentProgram, AgentRole } from './api';
import { useT, type MessageKey } from './i18n';

const LOOK: Record<AgentProgram, { name: string; glyph: string; tone: string }> = {
  claude: { name: 'Claude', glyph: '✳', tone: 'bg-ui-tool-orange text-ui-tool-orange-fg' },
  codex: { name: 'Codex', glyph: '>_', tone: 'bg-ui-tool-green text-ui-tool-green-fg' },
};

export const programName = (program: AgentProgram) => LOOK[program].name;

/** A program's mark: its glyph on a tile of its colour. */
export function AgentMark({ program, size = 'sm' }: { program: AgentProgram; size?: 'sm' | 'md' }) {
  const look = LOOK[program];
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-inset font-mono font-semibold',
        size === 'sm' ? 'size-5 text-2xs' : 'size-8 text-sm',
        look.tone,
      )}
    >
      {look.glyph}
    </span>
  );
}

/** Claude's models by the names Claude Code takes; an empty one is its default. */
export const CLAUDE_MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const EFFORT_KEY: Record<(typeof EFFORTS)[number], MessageKey> = {
  '': 'agents.effortDefault',
  low: 'agents.effortLow',
  medium: 'agents.effortMedium',
  high: 'agents.effortHigh',
  xhigh: 'agents.effortXhigh',
  max: 'agents.effortMax',
};

export const ROLE: Record<AgentRole, { title: MessageKey; about: MessageKey; icon: LucideIcon }> = {
  design: { title: 'agents.design', about: 'agents.designAbout', icon: Palette },
  images: { title: 'agents.images', about: 'agents.imagesAbout', icon: ImageIcon },
  translation: { title: 'agents.translation', about: 'agents.translationAbout', icon: Languages },
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A model as people say it: Claude's by its name (Opus), another program's as it is written. */
const modelName = (choice: AgentChoice) =>
  choice.program === 'claude' ? capital(choice.model) : choice.model;

/** "Claude · Opus · high", in the words of the language shown. */
export function useChoiceName() {
  const t = useT();
  return (choice: AgentChoice, withEffort = true) =>
    [
      programName(choice.program),
      choice.model ? modelName(choice) : '',
      withEffort && choice.effort
        ? t(EFFORT_KEY[choice.effort as keyof typeof EFFORT_KEY] ?? 'agents.effortDefault')
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
}

/** The program, model and effort of one role: rows of fields, in the settings and the picker. */
export function AgentFields({
  role,
  value,
  onChange,
}: {
  role: AgentRole;
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
}) {
  const t = useT();
  const programs: AgentProgram[] = role === 'images' ? ['codex'] : ['claude', 'codex'];
  const effortOptions = EFFORTS.map((effort) => ({
    value: effort || 'default',
    label: t(EFFORT_KEY[effort]),
  }));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ui-fg-muted">{t('agents.program')}</span>
        <SegmentedControl
          aria-label={t('agents.program')}
          size="sm"
          fill
          value={value.program}
          onValueChange={(program) =>
            onChange({ program, model: '', effort: program === value.program ? value.effort : '' })
          }
          options={programs.map((program) => ({ value: program, label: programName(program) }))}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ui-fg-muted">{t('agents.model')}</span>
        {value.program === 'claude' ? (
          <Select
            aria-label={t('agents.model')}
            size="sm"
            value={value.model || 'default'}
            onValueChange={(model) =>
              onChange({ ...value, model: model === 'default' ? '' : model })
            }
            options={CLAUDE_MODELS.map((model) => ({
              value: model || 'default',
              label: model ? capital(model) : t('agents.modelDefault', { program: 'Claude Code' }),
            }))}
          />
        ) : (
          <Input
            aria-label={t('agents.model')}
            dir="ltr"
            value={value.model}
            placeholder={t('agents.modelDefault', { program: 'Codex' })}
            onChange={(event) =>
              onChange({
                ...value,
                model: event.target.value.replace(/[^a-zA-Z0-9.:_-]/g, '').slice(0, 40),
              })
            }
          />
        )}
      </div>
      {role !== 'images' && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ui-fg-muted">{t('agents.effort')}</span>
          <Select
            aria-label={t('agents.effort')}
            size="sm"
            value={value.effort || 'default'}
            onValueChange={(effort) =>
              onChange({ ...value, effort: effort === 'default' ? '' : effort })
            }
            options={effortOptions}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The composer's picker of one role, as the app's picker of model and effort: what works on this
 * chat, and the way to choose another for it alone. Marked when the chat chose its own.
 */
export function AgentPicker({
  role,
  value,
  own,
  onChange,
  onReset,
}: {
  role: AgentRole;
  value: AgentChoice;
  /** The chat chose this one itself, over the settings. */
  own: boolean;
  onChange: (next: AgentChoice) => void;
  onReset: () => void;
}) {
  const t = useT();
  const name = useChoiceName();
  const shown = value.model ? modelName(value) : programName(value.program);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${t(ROLE[role].title)}: ${name(value)}`}
          title={`${t(ROLE[role].title)}: ${name(value)}`}
          data-agent-role={role}
          data-own={own}
          className={cx(
            'min-w-0 shrink! gap-1! px-1.5! text-ui-fg-muted',
            own && 'bg-ui-accent-soft text-ui-accent-fg',
          )}
        >
          {/* The role, which each of the three is for; its words say the program or the model. */}
          <Icon icon={ROLE[role].icon} />
          <span dir="auto" className="min-w-0 max-w-16 truncate text-xs">
            {shown}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-popover">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Icon icon={ROLE[role].icon} />
              {t(ROLE[role].title)}
            </span>
            <span className="text-xs text-ui-fg-muted">{t(ROLE[role].about)}</span>
          </div>
          <AgentFields role={role} value={value} onChange={onChange} />
          <div className="flex items-center gap-2 border-t border-ui-line pt-2">
            <span className="min-w-0 flex-1 text-xs text-ui-fg-muted">
              {own ? t('agents.ownChoice') : t('agents.fromSettings')}
            </span>
            {own && (
              <Button size="sm" variant="ghost" onClick={onReset}>
                {t('agents.useSettings')}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
