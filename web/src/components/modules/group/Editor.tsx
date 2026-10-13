import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDownIcon, HelpCircle, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { Protocol, useChannelGrantList } from '@/api/channel';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Accordion, AccordionContent, AccordionItem } from '@/components/ui/accordion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getModelIcon } from '@/lib/model-icons';
import type { GroupMode, GroupRelayConfig } from '@/api/group';
import type { SelectedMember } from './ItemList';
import { MemberList } from './ItemList';
import { MAX_MATCH_PATTERN_LENGTH, compileMatchPattern, matchesAutoAdd, memberKey, normalizeKey } from './utils';

export type GroupEditorValues = {
    name: string;
    mode: GroupMode;
    relay_config: GroupRelayConfig;
    matchPattern: string;
    members: SelectedMember[];
};

// defaultRelayConfig 提供创建分组时的前端初始配置。
const defaultRelayConfig: GroupRelayConfig = {
    member_max_attempts: 2,
    member_retry_interval_seconds: 1,
    member_non_stream_response_timeout_seconds: 120,
    member_stream_first_event_timeout_seconds: 30,
    member_cooldown_seconds: 60,
    member_affinity_seconds: 0,
};

// PROTOCOL_TAGS 是凭据行上的协议标识。
// 此处写全称: 凭据行只有名称一列, 横向有余量; 渠道表单的授权矩阵是三列复选框, 列宽紧张才用缩写。
const PROTOCOL_TAGS = [
    { bit: Protocol.OpenAIChatCompletion, label: 'Chat' },
    { bit: Protocol.OpenAIResponse, label: 'Response' },
    { bit: Protocol.AnthropicMessage, label: 'Message' },
];

// FieldHelp 渲染配置字段的简短帮助提示。
function FieldHelp({ text }: { text: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <HelpCircle className="size-4 cursor-help text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={10} align="center">
                {text}
            </TooltipContent>
        </Tooltip>
    );
}

function ModelPickerSection({
    grantMembers,
    selectedMembers,
    onAdd,
    onAutoAdd,
    autoAddDisabled,
    autoAddCount,
    matchPattern,
    onMatchPatternChange,
    matchPatternInvalid,
}: {
    grantMembers: SelectedMember[];
    selectedMembers: SelectedMember[];
    onAdd: (channel: SelectedMember) => void;
    onAutoAdd: () => void;
    autoAddDisabled: boolean;
    autoAddCount: number;
    matchPattern: string;
    onMatchPatternChange: (value: string) => void;
    matchPatternInvalid: boolean;
}) {
    const t = useTranslations('group');
    const [searchKeyword, setSearchKeyword] = useState('');

    const selectedKeys = useMemo(() => new Set(selectedMembers.map(memberKey)), [selectedMembers]);
    const normalizedSearch = searchKeyword.trim().toLowerCase();

    // 候选按渠道 -> 模型 -> 凭据三级组织: 一个模型可有多份凭据, 各自是独立授权, 需再展开一级才能分别选取。
    // 三级顺序沿用后端给出的候选顺序: Map 保留插入顺序, 后端已按渠道, 模型, 凭据排好, 此处无需再排。
    const channels = useMemo(() => {
        const byChannel = new Map<number, {
            id: number;
            name: string;
            models: Map<string, SelectedMember[]>;
        }>();
        grantMembers.forEach((mc) => {
            let channel = byChannel.get(mc.channel_id);
            if (!channel) {
                channel = { id: mc.channel_id, name: mc.channel_name, models: new Map() };
                byChannel.set(mc.channel_id, channel);
            }
            const grants = channel.models.get(mc.name);
            if (grants) grants.push(mc);
            else channel.models.set(mc.name, [mc]);
        });

        return Array.from(byChannel.values()).map((channel) => ({
            id: channel.id,
            name: channel.name,
            models: Array.from(channel.models, ([name, grants]) => ({ name, grants })),
        }));
    }, [grantMembers]);

    const filteredChannels = useMemo(() => {
        if (!normalizedSearch) return channels;
        return channels.reduce<typeof channels>((acc, channel) => {
            if (channel.name.toLowerCase().includes(normalizedSearch)) {
                acc.push(channel);
                return acc;
            }

            const models = channel.models.filter((model) => model.name.toLowerCase().includes(normalizedSearch));
            if (models.length > 0) acc.push({ ...channel, models });
            return acc;
        }, []);
    }, [channels, normalizedSearch]);

    return (
        <div className="rounded-xl border border-border/50 bg-muted/30 flex flex-col min-h-0">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2 border-b border-border/30 bg-muted/50">
                <span className="min-w-0 justify-self-start text-sm font-medium text-foreground">
                    {t('form.addItem')}
                </span>

                <div className="relative justify-self-center w-30">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={searchKeyword}
                        onChange={(event) => setSearchKeyword(event.target.value)}
                        className="h-6 rounded-lg border-border/60 bg-background/70 pl-7 pr-2 text-xs shadow-none focus-visible:border-border/60 focus-visible:ring-0"
                        aria-label="search"
                    />
                </div>

                <button
                    type="button"
                    onClick={onAutoAdd}
                    className={cn(
                        'justify-self-end shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors',
                        autoAddDisabled
                            ? 'text-muted-foreground/50 cursor-not-allowed'
                            : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                    )}
                    disabled={autoAddDisabled}
                >
                    <Sparkles className="size-3.5" />
                    <span>{t('form.autoAdd')}</span>
                    {autoAddCount > 0 && <span className="tabular-nums">{autoAddCount}</span>}
                </button>
            </div>

            {/* 匹配表达式随分组保存: 「自动添加」按它挑选成员, 渠道同步后的「更新分组」也按它补齐新模型。 */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30">
                <Input
                    value={matchPattern}
                    onChange={(event) => onMatchPatternChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') event.preventDefault();
                    }}
                    maxLength={MAX_MATCH_PATTERN_LENGTH}
                    placeholder={t('form.matchPatternPlaceholder')}
                    aria-label={t('form.matchPattern')}
                    aria-invalid={matchPatternInvalid}
                    className={cn(
                        'h-6 rounded-lg border-border/60 bg-background/70 px-2 text-xs shadow-none focus-visible:ring-0',
                        matchPatternInvalid && 'border-destructive/60 text-destructive'
                    )}
                />
                <span className={cn('shrink-0 text-xs', matchPatternInvalid ? 'text-destructive' : 'text-muted-foreground')}>
                    {matchPatternInvalid ? t('form.matchPatternInvalid') : t('form.addableCount', { count: autoAddCount })}
                </span>
                <FieldHelp text={t('form.matchPatternHint')} />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2">
                <Accordion type="multiple" className="w-full space-y-2">
                    {filteredChannels.map((channel) => {
                        // 计数按授权算而非按模型: 展开后每份凭据都是一个可选项。
                        const grants = channel.models.flatMap((model) => model.grants);
                        const total = grants.length;
                        const selectedCount = grants.reduce(
                            (acc, m) => acc + (selectedKeys.has(memberKey(m)) ? 1 : 0),
                            0
                        );
                        const available = total - selectedCount;

                        return (
                            <AccordionItem key={channel.id} value={`channel-${channel.id}`}>
                                <AccordionPrimitive.Header className="rounded-lg bg-muted sticky top-0 z-10 flex px-2 overflow-hidden">
                                    <AccordionPrimitive.Trigger className="flex flex-1 min-w-0 items-center gap-4 py-4 text-left text-sm transition-all outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180">
                                        <span className="truncate">{channel.name}</span>
                                        <span className="text-xs text-muted-foreground shrink-0">
                                            {available}/{total}
                                        </span>
                                        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform duration-200" />
                                    </AccordionPrimitive.Trigger>
                                </AccordionPrimitive.Header>
                                <AccordionContent className="px-2 pt-2">
                                    <div className="flex flex-col gap-1.5">
                                        {channel.models.map((model) => {
                                            const { Icon, className: iconClassName } = getModelIcon(model.name);
                                            const modelSelected = model.grants.reduce(
                                                (acc, m) => acc + (selectedKeys.has(memberKey(m)) ? 1 : 0),
                                                0
                                            );
                                            return (
                                                <div key={model.name} className="rounded-lg border border-border/50 bg-background">
                                                    {/* 模型行只作分组标题, 不可点选: 可选的是它下面的凭据, 一份凭据一条授权。 */}
                                                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                                                        <span className="flex items-center gap-2 min-w-0">
                                                            <Icon aria-hidden="true" className={iconClassName} width={16} height={16} />
                                                            <span className="text-sm font-medium truncate">{model.name}</span>
                                                        </span>
                                                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                                            {model.grants.length - modelSelected}/{model.grants.length}
                                                        </span>
                                                    </div>

                                                    <div className="flex flex-col border-t border-border/50">
                                                        {model.grants.map((m) => {
                                                            const isSelected = selectedKeys.has(memberKey(m));
                                                            return (
                                                                <button
                                                                    key={memberKey(m)}
                                                                    type="button"
                                                                    onClick={() => !isSelected && onAdd(m)}
                                                                    disabled={isSelected}
                                                                    className={cn(
                                                                        'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 pl-8 text-left transition-colors',
                                                                        isSelected ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted'
                                                                    )}
                                                                >
                                                                    <span className="flex min-w-0 items-center gap-2">
                                                                        <span className="truncate text-xs text-muted-foreground">{m.key_name}</span>
                                                                        {/* 标出该凭据讲得通的协议: 同一模型的不同凭据可能只支持其中一部分, 选之前就要能看出来。 */}
                                                                        {PROTOCOL_TAGS.map(({ bit, label }) => (m.protocols & bit) !== 0 && (
                                                                            <span
                                                                                key={bit}
                                                                                className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground"
                                                                            >
                                                                                {label}
                                                                            </span>
                                                                        ))}
                                                                    </span>
                                                                    <span className="shrink-0 text-muted-foreground">
                                                                        {isSelected ? (
                                                                            <Check className="size-4 text-primary" />
                                                                        ) : (
                                                                            <Plus className="size-4" />
                                                                        )}
                                                                    </span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        );
                    })}
                </Accordion>
            </div>
        </div>
    );
}

function SortSection({
    members,
    onReorder,
    onRemove,
    removingIds,
    onClear,
}: {
    members: SelectedMember[];
    onReorder: (members: SelectedMember[]) => void;
    onRemove: (id: string) => void;
    removingIds: Set<string>;
    onClear: () => void;
}) {
    const t = useTranslations('group');

    return (
        <div className="rounded-xl border border-border/50 bg-muted/30 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 bg-muted/50">
                <span className="text-sm font-medium text-foreground">
                    {t('form.items')}
                    {members.length > 0 && (
                        <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                            ({members.length})
                        </span>
                    )}
                </span>
                <button
                    type="button"
                    onClick={onClear}
                    disabled={members.length === 0}
                    className={cn(
                        'flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors',
                        members.length === 0
                            ? 'text-muted-foreground/50 cursor-not-allowed'
                            : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                    )}
                >
                    <Trash2 className="size-3.5" />
                    <span>{t('form.clear')}</span>
                </button>
            </div>

            <div className="flex-1 min-h-0">
                <MemberList
                    members={members}
                    onReorder={onReorder}
                    onRemove={onRemove}
                    removingIds={removingIds}
                    showConfirmDelete={false}
                />
            </div>
        </div>
    );
}

export function GroupEditor({
    initial,
    submitText,
    submittingText,
    isSubmitting,
    onSubmit,
    onCancel,
}: {
    initial?: {
        name?: string;
        mode?: GroupMode;
        relay_config?: Partial<GroupRelayConfig>;
        matchPattern?: string;
        members?: SelectedMember[];
    };
    submitText: string;
    submittingText: string;
    isSubmitting: boolean;
    onSubmit: (values: GroupEditorValues) => void;
    onCancel?: () => void;
}) {
    const t = useTranslations('group');
    const { data: grantCandidates = [] } = useChannelGrantList();
    const grantMembers = useMemo<SelectedMember[]>(() => grantCandidates.map((grant) => ({
        id: String(grant.id),
        channel_grant_id: grant.id,
        name: grant.model_name,
        enabled: grant.available,
        channel_id: grant.channel_id,
        channel_name: grant.channel_name,
        key_name: grant.key_name,
        protocols: grant.protocols,
    })), [grantCandidates]);

    const [groupName, setGroupName] = useState(initial?.name ?? '');
    const [mode, setMode] = useState<GroupMode>(initial?.mode ?? 'manual');
    const [relayConfig, setRelayConfig] = useState<GroupRelayConfig>(() => ({
        ...defaultRelayConfig,
        ...initial?.relay_config,
    }));
    const [selectedMembers, setSelectedMembers] = useState<SelectedMember[]>(initial?.members ?? []);
    const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
    const [matchPattern, setMatchPattern] = useState(initial?.matchPattern ?? '');

    const groupKey = normalizeKey(groupName);
    const { regex: matchRegex, invalid: matchPatternInvalid } = useMemo(() => compileMatchPattern(matchPattern), [matchPattern]);

    const matchedModelChannels = useMemo(() => {
        // 表达式非法时不退回字面量匹配: 否则按钮禁用期间列表看起来仍是「按分组名匹配」的结果, 与输入不符。
        if (matchPatternInvalid) return [];
        if (!matchRegex && !groupKey) return [];
        return grantMembers.filter((mc) => matchesAutoAdd(mc.name, groupKey, matchRegex));
    }, [groupKey, grantMembers, matchRegex, matchPatternInvalid]);

    const handleAddMember = useCallback((channel: SelectedMember) => {
        const key = memberKey(channel);
        setSelectedMembers((prev) => {
            if (prev.some((m) => m.id === key)) return prev;
            return [...prev, { ...channel, id: key }];
        });
    }, []);

    // 按钮上的数字是「这次会新增多少项」, 与 autoAddDisabled 用同一口径, 避免按钮可用但数字为 0。
    const autoAddCount = useMemo(() => {
        const existing = new Set(selectedMembers.map((m) => m.id));
        return matchedModelChannels.filter((mc) => !existing.has(memberKey(mc))).length;
    }, [matchedModelChannels, selectedMembers]);

    const autoAddDisabled = matchPatternInvalid || autoAddCount === 0;

    const handleAutoAdd = useCallback(() => {
        if (matchedModelChannels.length === 0) return;
        setSelectedMembers((prev) => {
            const existing = new Set(prev.map((m) => m.id));
            const toAdd = matchedModelChannels
                .filter((mc) => !existing.has(memberKey(mc)))
                .map((mc) => ({ ...mc, id: memberKey(mc) }));
            return toAdd.length ? [...prev, ...toAdd] : prev;
        });
    }, [matchedModelChannels]);

    const handleRemoveMember = useCallback((id: string) => {
        setRemovingIds((prev) => new Set(prev).add(id));
        setTimeout(() => {
            setSelectedMembers((prev) => prev.filter((m) => m.id !== id));
            setRemovingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
        }, 200);
    }, []);

    const handleClearMembers = useCallback(() => {
        setSelectedMembers([]);
        setRemovingIds(new Set());
    }, []);

    // 非法表达式在输入框旁已标红, 这里一并挡住提交: 后端写入侧同样会拒绝, 不该等它报错才发现。
    const isValid = groupKey.length > 0 && selectedMembers.length > 0 && !matchPatternInvalid;

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!isValid) return;
        onSubmit({
            name: groupName,
            mode,
            relay_config: relayConfig,
            matchPattern: matchPattern.trim(),
            members: selectedMembers,
        });
    };


    return (
        <form onSubmit={handleSubmit} className="flex flex-col h-full min-h-0 ">
            <div className="flex-1 min-h-0 overflow-hidden px-1">
                <FieldGroup className="gap-4 flex flex-col min-h-0 h-full">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field>
                            <FieldLabel htmlFor="group-name">{t('form.name')}</FieldLabel>
                            <Input
                                id="group-name"
                                value={groupName}
                                onChange={(e) => setGroupName(e.target.value)}
                                className="rounded-xl"
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="group-mode">
                                {t('form.mode')}
                                <FieldHelp text={t('form.modeHint')} />
                            </FieldLabel>
                            <Select
                                value={mode}
                                onValueChange={(value) => setMode(value as GroupMode)}
                            >
                                <SelectTrigger id="group-mode" className="w-full rounded-xl">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="manual">{t('form.manual')}</SelectItem>
                                    <SelectItem value="failover">{t('form.failover')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>

                    <Tabs defaultValue="members" className="flex flex-1 min-h-0">
                        <TabsList className="grid w-full shrink-0 grid-cols-2">
                            <TabsTrigger value="members">{t('form.members')}</TabsTrigger>
                            <TabsTrigger value="relay">{t('form.relay')}</TabsTrigger>
                        </TabsList>

                        <TabsContent value="members" className="min-h-0 overflow-hidden">
                            <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-2">
                                <ModelPickerSection
                                    grantMembers={grantMembers}
                                    selectedMembers={selectedMembers}
                                    onAdd={handleAddMember}
                                    onAutoAdd={handleAutoAdd}
                                    autoAddDisabled={autoAddDisabled}
                                    autoAddCount={autoAddCount}
                                    matchPattern={matchPattern}
                                    onMatchPatternChange={setMatchPattern}
                                    matchPatternInvalid={matchPatternInvalid}
                                />
                                <SortSection
                                    members={selectedMembers}
                                    onReorder={setSelectedMembers}
                                    onRemove={handleRemoveMember}
                                    removingIds={removingIds}
                                    onClear={handleClearMembers}
                                />
                            </div>
                        </TabsContent>

                        <TabsContent value="relay" className="min-h-0 overflow-y-auto px-1">
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <Field>
                                    <FieldLabel htmlFor="group-retry-count">
                                        {t('form.retryCount')}
                                        <FieldHelp text={t('form.retryCountHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-retry-count"
                                        type="number"
                                        inputMode="numeric"
                                        min={0}
                                        step={1}
                                        value={String(relayConfig.member_max_attempts)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_max_attempts: Number.isFinite(value) && value >= 1 ? value : 1 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                                <Field>
                                    <FieldLabel htmlFor="group-retry-interval">
                                        {t('form.retryInterval')}
                                        <FieldHelp text={t('form.retryIntervalHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-retry-interval"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        step={1}
                                        value={String(relayConfig.member_retry_interval_seconds)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_retry_interval_seconds: Number.isFinite(value) && value >= 1 ? value : 1 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                                <Field>
                                    <FieldLabel htmlFor="group-non-stream-timeout">
                                        {t('form.nonStreamTimeout')}
                                        <FieldHelp text={t('form.nonStreamTimeoutHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-non-stream-timeout"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        step={1}
                                        value={String(relayConfig.member_non_stream_response_timeout_seconds)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_non_stream_response_timeout_seconds: Number.isFinite(value) && value >= 1 ? value : 1 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                                <Field>
                                    <FieldLabel htmlFor="group-stream-timeout">
                                        {t('form.streamTimeout')}
                                        <FieldHelp text={t('form.streamTimeoutHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-stream-timeout"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        step={1}
                                        value={String(relayConfig.member_stream_first_event_timeout_seconds)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_stream_first_event_timeout_seconds: Number.isFinite(value) && value >= 1 ? value : 1 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                                <Field>
                                    <FieldLabel htmlFor="group-cooldown">
                                        {t('form.cooldown')}
                                        <FieldHelp text={t('form.cooldownHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-cooldown"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        step={1}
                                        value={String(relayConfig.member_cooldown_seconds)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_cooldown_seconds: Number.isFinite(value) && value >= 1 ? value : 1 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                                <Field>
                                    <FieldLabel htmlFor="group-affinity">
                                        {t('form.affinity')}
                                        <FieldHelp text={t('form.affinityHint')} />
                                    </FieldLabel>
                                    <Input
                                        id="group-affinity"
                                        type="number"
                                        inputMode="numeric"
                                        min={0}
                                        step={1}
                                        value={String(relayConfig.member_affinity_seconds)}
                                        onChange={(event) => {
                                            const value = Number.parseInt(event.target.value, 10);
                                            setRelayConfig((prev) => ({ ...prev, member_affinity_seconds: Number.isFinite(value) && value >= 0 ? value : 0 }));
                                        }}
                                        className="rounded-xl"
                                    />
                                </Field>
                            </div>
                        </TabsContent>
                    </Tabs>
                </FieldGroup>
            </div>

            <div className="pt-4 mt-auto shrink-0">
                <div className="flex gap-2">
                    {onCancel && (
                        <Button type="button" variant="secondary" className="flex-1 rounded-xl h-11" onClick={onCancel}>
                            {t('detail.actions.cancel')}
                        </Button>
                    )}
                    <Button
                        type="submit"
                        disabled={!isValid || isSubmitting}
                        className="flex-1 rounded-xl h-11"
                    >
                        {isSubmitting ? submittingText : submitText}
                    </Button>
                </div>
            </div>
        </form>
    );
}
