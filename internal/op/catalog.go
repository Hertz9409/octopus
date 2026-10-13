package op

import (
	"sort"
	"time"

	"github.com/bestruirui/octopus/internal/catalog"
	"github.com/bestruirui/octopus/internal/model"
)

// 模型被规则丢弃的原因, 由界面翻译成文案。
const (
	CatalogDropUnknown    = "unknown"    // 目录里没有这个模型
	CatalogDropDeprecated = "deprecated" // 目录标记为已弃用
	CatalogDropToolCall   = "tool_call"  // 不支持工具调用
	CatalogDropContext    = "context"    // 上下文低于下限
	CatalogDropRelease    = "release"    // 发布时间早于窗口
)

// CatalogFilter 是模型库规则在进程内的形态。渠道同步模型时按同一份口径过滤。
type CatalogFilter struct {
	Enabled         bool
	ReleaseDays     int
	RequireToolCall bool
	MinContext      int
	DropDeprecated  bool
	UnknownPolicy   string
}

// CatalogFilterGet 读取当前规则。设置缺失或非法时回退到不过滤, 避免误删模型。
func CatalogFilterGet() CatalogFilter {
	filter := CatalogFilter{DropDeprecated: true, UnknownPolicy: "keep"}
	enabled, err := SettingGetBool(model.SettingKeyCatalogFilterEnabled)
	if err != nil {
		return filter
	}
	filter.Enabled = enabled
	if days, err := SettingGetInt(model.SettingKeyCatalogReleaseDays); err == nil && days > 0 {
		filter.ReleaseDays = days
	}
	if require, err := SettingGetBool(model.SettingKeyCatalogRequireTool); err == nil {
		filter.RequireToolCall = require
	}
	if minContext, err := SettingGetInt(model.SettingKeyCatalogMinContext); err == nil && minContext > 0 {
		filter.MinContext = minContext
	}
	if drop, err := SettingGetBool(model.SettingKeyCatalogDropDeprecated); err == nil {
		filter.DropDeprecated = drop
	}
	if policy, err := SettingGetString(model.SettingKeyCatalogUnknownPolicy); err == nil && policy != "" {
		filter.UnknownPolicy = policy
	}
	return filter
}

// Keep 判断单个模型名是否保留, 并给出丢弃原因。
// 规则总开关关闭或目录为空时一律保留: 前者避免库里残留的 unknown_policy=drop 在关掉规则后继续删模型,
// 后者避免用一份还没拉取成功的空目录把所有渠道模型判成「未收录」再删掉。
// 目录里没有的模型按未收录策略处理: 规则收紧不应该误删不认识的模型。
func (f CatalogFilter) Keep(name string) (catalog.Entry, bool, bool, string) {
	if !f.Enabled || catalog.Count() == 0 {
		entry, matched := catalog.Resolve(name)
		return entry, matched, true, ""
	}
	entry, matched := catalog.Resolve(name)
	if !matched {
		if f.UnknownPolicy == "drop" {
			return entry, false, false, CatalogDropUnknown
		}
		return entry, false, true, ""
	}
	if f.DropDeprecated && entry.Status == "deprecated" {
		return entry, true, false, CatalogDropDeprecated
	}
	if f.RequireToolCall && !entry.ToolCall {
		return entry, true, false, CatalogDropToolCall
	}
	if f.MinContext > 0 && entry.ContextWindow > 0 && entry.ContextWindow < f.MinContext {
		return entry, true, false, CatalogDropContext
	}
	if f.ReleaseDays > 0 {
		if date, ok := parseReleaseDate(entry.ReleaseDate); ok {
			if date.Before(releaseCutoff(f.ReleaseDays)) {
				return entry, true, false, CatalogDropRelease
			}
		}
	}
	return entry, true, true, ""
}

// CatalogModelList 汇总渠道在售的模型, 附上目录元数据与当前规则的判定结果。
// 同一模型的不同写法(日期后缀、供应商前缀)归并成一行, 原始名字留在 RawNames 里。
func CatalogModelList() ([]model.CatalogModelItem, model.CatalogSummary) {
	filter := CatalogFilterGet()
	summary := model.CatalogSummary{
		CatalogCount: catalog.Count(),
		CatalogSize:  catalog.Size(),
		UpdatedAt:    int(catalog.UpdatedAt().Unix()),
	}
	rows := make(map[string]*catalogRow, channelModelCache.Len())
	for _, channelModel := range channelModelCache.GetAll() {
		channel, ok := channelCache.Get(channelModel.ChannelID)
		if !ok {
			continue
		}
		// 这里只借 Keep 做归并: 页面按用户正在编辑的规则自行预判是否保留。
		entry, matched, _, _ := filter.Keep(channelModel.Name)
		key := channelModel.Name
		if matched {
			key = entry.Identity
		}
		row, ok := rows[key]
		if !ok {
			row = &catalogRow{item: model.CatalogModelItem{
				ModelID:  channelModel.Name,
				Identity: key,
				Matched:  matched,
			}, channels: map[string]bool{}, names: map[string]bool{}}
			if matched {
				row.item.ModelID = entry.ModelID
				row.item.Developer = entry.Developer
				row.item.ReleaseDate = entry.ReleaseDate
				row.item.ToolCall = entry.ToolCall
				row.item.Context = entry.ContextWindow
				row.item.Status = entry.Status
			}
			rows[key] = row
		}
		row.channels[channel.Name] = true
		row.names[channelModel.Name] = true
	}
	items := make([]model.CatalogModelItem, 0, len(rows))
	for _, row := range rows {
		row.item.Channels = sortedKeys(row.channels)
		row.item.RawNames = sortedKeys(row.names)
		items = append(items, row.item)
	}
	sort.Slice(items, func(i, j int) bool {
		left, right := items[i], items[j]
		if left.Matched != right.Matched {
			return left.Matched
		}
		// 认不出研发商的排最后, 免得「其他」压在 Anthropic、OpenAI 前面。
		if (left.Developer == "") != (right.Developer == "") {
			return right.Developer == ""
		}
		if left.Developer != right.Developer {
			return left.Developer < right.Developer
		}
		if left.ReleaseDate != right.ReleaseDate {
			return left.ReleaseDate > right.ReleaseDate
		}
		return left.ModelID < right.ModelID
	})
	return items, summary
}

type catalogRow struct {
	item     model.CatalogModelItem
	channels map[string]bool
	names    map[string]bool
}

func sortedKeys(source map[string]bool) []string {
	keys := make([]string, 0, len(source))
	for key := range source {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// parseReleaseDate 解析目录里的发布日期。目录缺失或格式异常时返回 false, 调用方按「没有日期信息」处理。
func parseReleaseDate(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	date, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, false
	}
	return date, true
}

// releaseCutoff 返回「保留最近 days 天」的时间下界。
func releaseCutoff(days int) time.Time {
	return time.Now().AddDate(0, 0, -days)
}
