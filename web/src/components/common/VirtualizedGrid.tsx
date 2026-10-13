import {
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const BREAKPOINTS = {
    sm: 640,
    md: 768,
    lg: 960,
    xl: 1280,
    '2xl': 1536,
} as const;

type Breakpoint = keyof typeof BREAKPOINTS;
type ResponsiveColumns = Partial<Record<Breakpoint | 'default', number>>;

interface VirtualizedGridProps<T> {
    items: T[];
    layout?: 'grid' | 'list';
    columns: ResponsiveColumns;
    estimateItemHeight: number;
    gap?: number;
    overscan?: number;
    getItemKey: (item: T, index: number) => string | number;
    renderItem: (item: T, index: number) => ReactNode;
    footer?: ReactNode;
    /** 列表为空时展示的内容；为空则只渲染空容器。 */
    emptyState?: ReactNode;
    onReachEnd?: () => void;
    reachEndEnabled?: boolean;
    reachEndOffset?: number;
}

function getColumnsForWidth(
    width: number,
    columns: ResponsiveColumns,
): number {
    if (width >= BREAKPOINTS['2xl'] && columns['2xl'] !== undefined) return columns['2xl'];
    if (width >= BREAKPOINTS.xl && columns.xl !== undefined) return columns.xl;
    if (width >= BREAKPOINTS.lg && columns.lg !== undefined) return columns.lg;
    if (width >= BREAKPOINTS.md && columns.md !== undefined) return columns.md;
    if (width >= BREAKPOINTS.sm && columns.sm !== undefined) return columns.sm;
    return columns.default ?? 1;
}

export function VirtualizedGrid<T>({
    items,
    layout = 'grid',
    columns,
    estimateItemHeight,
    gap = 16,
    overscan = 4,
    getItemKey,
    renderItem,
    footer = null,
    emptyState = null,
    onReachEnd,
    reachEndEnabled = false,
    reachEndOffset = 1,
}: VirtualizedGridProps<T>) {
    'use no memo';

    const [containerWidth, setContainerWidth] = useState(() =>
        typeof window === 'undefined' ? 1024 : window.innerWidth
    );
    const containerRef = useRef<HTMLDivElement | null>(null);
    const reachEndTriggeredRef = useRef(false);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateWidth = () => {
            const nextWidth = el.clientWidth;
            setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };

        updateWidth();

        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateWidth);
        observer.observe(el);

        return () => {
            observer.disconnect();
        };
    }, []);

    const columnCount = useMemo(() => {
        if (layout === 'list') return 1;
        return Math.max(1, getColumnsForWidth(containerWidth, columns));
    }, [layout, containerWidth, columns]);

    const itemRowCount = useMemo(
        () => (items.length === 0 ? 0 : Math.ceil(items.length / columnCount)),
        [items.length, columnCount]
    );
    const hasFooterRow = footer !== null;
    const rowCount = itemRowCount + (hasFooterRow ? 1 : 0);
    const getVirtualRowKey = useCallback((rowIndex: number) => {
        if (hasFooterRow && rowIndex === itemRowCount) {
            return '__virtual-footer__';
        }

        const rowStartIndex = rowIndex * columnCount;
        if (columnCount === 1) {
            const item = items[rowStartIndex];
            if (!item) return `row-empty-${rowIndex}`;

            // 单列布局(日志流)每行就是一条记录: 用记录自身的 key, 头部插入新记录时已有行不受影响。
            return `row-${String(getItemKey(item, rowStartIndex))}`;
        }
        const rowEndIndex = Math.min(rowStartIndex + columnCount, items.length) - 1;
        const lastItem = items[rowEndIndex];
        if (!lastItem) return `row-empty-${rowIndex}`;

        // 网格布局按行内最后一项派生 key: 追加时末行稳定, 头部插入仍会改变各行 key,
        // 这是行分组本身的限制, 只能在列表布局里彻底避免。
        return `row-${String(getItemKey(lastItem, rowEndIndex))}`;
    }, [hasFooterRow, itemRowCount, columnCount, items, getItemKey]);

    // eslint-disable-next-line react-hooks/incompatible-library
    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => containerRef.current,
        getItemKey: getVirtualRowKey,
        estimateSize: () => estimateItemHeight + gap,
        // Use layout height (not transformed visual height) to avoid scale-animation
        // shrinking measurements during page enter transitions.
        measureElement: (element) =>
            element instanceof HTMLElement
                ? element.offsetHeight
                : element.getBoundingClientRect().height,
        overscan,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();

    useEffect(() => {
        if (!onReachEnd || !reachEndEnabled || itemRowCount === 0) return;

        const lastVirtualIndex = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1]!.index : -1;
        const triggerIndex = Math.max(0, itemRowCount - 1 - reachEndOffset);
        if (lastVirtualIndex < triggerIndex) {
            reachEndTriggeredRef.current = false;
            return;
        }
        if (reachEndTriggeredRef.current) return;

        reachEndTriggeredRef.current = true;
        onReachEnd();
    }, [onReachEnd, reachEndEnabled, itemRowCount, reachEndOffset, virtualRows]);

    return (
        <div className="relative h-full min-h-0 w-full">
            <div
                ref={containerRef}
                className="relative h-full w-full overflow-y-auto overscroll-contain rounded-t-3xl"
            >
                {rowCount === 0 ? (
                    emptyState ? <div className="flex h-full items-center justify-center p-6">{emptyState}</div> : null
                ) : (
                    <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                        {virtualRows.map((virtualRow) => {
                            if (hasFooterRow && virtualRow.index === itemRowCount) {
                                return (
                                    <div
                                        key={virtualRow.key}
                                        data-index={virtualRow.index}
                                        ref={rowVirtualizer.measureElement}
                                        className="absolute left-0 top-0 w-full"
                                        style={{
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        {footer}
                                    </div>
                                );
                            }

                            const rowStartIndex = virtualRow.index * columnCount;
                            const rowEndIndex = Math.min(rowStartIndex + columnCount, items.length);
                            const rowItems = items.slice(rowStartIndex, rowEndIndex);
                            const rowPaddingBottom = virtualRow.index === itemRowCount - 1 && !hasFooterRow ? 0 : gap;

                            return (
                                <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    ref={rowVirtualizer.measureElement}
                                    className="absolute left-0 top-0 w-full"
                                    style={{
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <div
                                        className="grid"
                                        style={{
                                            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                                            gap: `${gap}px`,
                                            paddingBottom: `${rowPaddingBottom}px`,
                                        }}
                                    >
                                        {rowItems.map((item, columnIndex) => {
                                            const itemIndex = rowStartIndex + columnIndex;
                                            return (
                                                <div key={String(getItemKey(item, itemIndex))} className="min-w-0">
                                                    {renderItem(item, itemIndex)}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                {/* 移动端底部导航是固定定位，列表末尾留出可滚动空间避免最后一张卡片被压住。 */}
                <div aria-hidden="true" className="h-24 shrink-0 md:h-0" />
            </div>
        </div>
    );
}
