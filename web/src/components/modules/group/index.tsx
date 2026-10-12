import { useMemo, useSyncExternalStore } from 'react';
import { ArrowUpAZ } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { GroupCard } from './Card';
import { CreateDialogContent } from './Create';
import { useRuntimeClock } from './MemberStatus';
import { getGroupEventStatus, subscribeGroupEventStatus, useGroupList } from '@/api/group';
import { errorMessage } from '@/api/client';
import { PageActions, usePageActionsStore } from '@/components/common/PageActions';
import { ListState } from '@/components/common/ListState';
import { VirtualizedGrid } from '@/components/common/VirtualizedGrid';

// GroupActions 向稳定顶栏提供分组页面的搜索、视图选项和创建入口。
export function GroupActions() {
    const t = useTranslations('toolbar');
    const searchTerm = usePageActionsStore((state) => state.searchTerms.group || '');
    const sortOrder = usePageActionsStore((state) => state.sortOrders.group === 'desc' ? 'desc' : 'asc');
    const filter = usePageActionsStore((state) => state.groupFilter);
    const setSearchTerm = usePageActionsStore((state) => state.setSearchTerm);
    const setSort = usePageActionsStore((state) => state.setSort);
    const setFilter = usePageActionsStore((state) => state.setGroupFilter);

    return (
        <PageActions
            searchTerm={searchTerm}
            onSearchTermChange={(value) => setSearchTerm('group', value)}
            sortOptions={[
                { value: 'asc', label: t('popover.nameAsc'), icon: ArrowUpAZ },
                { value: 'desc', label: t('popover.nameDesc'), icon: ArrowUpAZ },
            ]}
            sortValue={sortOrder}
            onSortChange={(value) => {
                if (value === 'asc' || value === 'desc') setSort('group', value);
            }}
            filterOptions={[
                { value: 'all', label: t('popover.filter.group.all') },
                { value: 'with-members', label: t('popover.filter.group.withMembers') },
                { value: 'empty', label: t('popover.filter.group.empty') },
            ]}
            filterValue={filter}
            onFilterChange={(value) => {
                if (value === 'all' || value === 'with-members' || value === 'empty') setFilter(value);
            }}
        >
            <CreateDialogContent />
        </PageActions>
    );
}

// Group 渲染分组列表正文。
export function Group() {
    const t = useTranslations('group');
    const tCommon = useTranslations('common');
    const { data: groups, isPending, isError, error, refetch } = useGroupList(true, true);
    const eventStatus = useSyncExternalStore(subscribeGroupEventStatus, getGroupEventStatus, getGroupEventStatus);
    const runtimeNow = useRuntimeClock(groups);
    const searchTerm = usePageActionsStore((state) => state.searchTerms.group || '');
    const sortOrder = usePageActionsStore((state) => state.sortOrders.group === 'desc' ? 'desc' : 'asc');
    const filter = usePageActionsStore((state) => state.groupFilter);

    const sortedGroups = useMemo(() => {
        if (!groups) return [];
        return [...groups].sort((a, b) =>
            sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
        );
    }, [groups, sortOrder]);

    const visibleGroups = useMemo(() => {
        const term = searchTerm.toLowerCase().trim();
        const byName = !term ? sortedGroups : sortedGroups.filter((g) => g.name.toLowerCase().includes(term));

        if (filter === 'with-members') return byName.filter((g) => (g.items?.length || 0) > 0);
        if (filter === 'empty') return byName.filter((g) => (g.items?.length || 0) === 0);

        return byName;
    }, [sortedGroups, searchTerm, filter]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            {eventStatus === 'closed' && (
                <div className="flex shrink-0 items-center justify-center px-1 pb-3 text-xs text-muted-foreground">
                    <span>{tCommon('reconnecting')}</span>
                </div>
            )}
            <div className="min-h-0 flex-1">
                <VirtualizedGrid
                    items={visibleGroups}
                    columns={{ default: 1, md: 2, lg: 3 }}
                    estimateItemHeight={520}
                    getItemKey={(group) => group.id}
                    emptyState={
                        isPending ? (
                            <ListState kind="loading" />
                        ) : isError ? (
                            <ListState kind="error" errorDescription={errorMessage(error)} onRetry={() => void refetch()} />
                        ) : (
                            <ListState kind="empty" emptyText={t('card.emptyList')} />
                        )
                    }
                    renderItem={(group) => {
                        let deadline = group.runtime.affinity_until;
                        for (const cooldownUntil of Object.values(group.runtime.cooldowns)) {
                            deadline = Math.max(deadline, cooldownUntil);
                        }
                        return <GroupCard group={group} now={deadline > runtimeNow ? runtimeNow : deadline} />;
                    }}
                />
            </div>
        </div>
    );
}
