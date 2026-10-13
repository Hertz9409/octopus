package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/bestruirui/octopus/internal/db"
	"github.com/bestruirui/octopus/internal/model"
	"github.com/charmbracelet/log"
	"gorm.io/gorm"
)

// firstPartyProviders 是研发商自己的 provider, 同一个模型 id 出现在多个 provider 下时优先取这些来源。
var firstPartyProviders = map[string]bool{
	"openai": true, "anthropic": true, "google": true, "deepseek": true, "xai": true,
	"alibaba": true, "zhipuai": true, "minimax": true, "moonshotai": true, "xiaomi": true,
	"meta": true, "mistralai": true, "nvidia": true, "bytedance": true, "tencent": true,
	"baidu": true, "stepfun": true, "inclusionai": true, "cohere": true, "ai21": true,
	"perplexity": true, "amazon": true, "microsoft": true, "ibm": true, "allenai": true,
}

type rawProvider struct {
	Models map[string]rawModel `json:"models"`
}

type rawModel struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Family           string `json:"family"`
	ReleaseDate      string `json:"release_date"`
	ToolCall         bool   `json:"tool_call"`
	Status           string `json:"status"`
	CanonicalModelID string `json:"canonical_model_id"`
	Modalities       struct {
		Output []string `json:"output"`
	} `json:"modalities"`
	Limit struct {
		Context int `json:"context"`
	} `json:"limit"`
}

// Parse 解析 models.dev 的 api.json, 返回按模型 id 去重后的目录条目。
func Parse(body []byte) ([]Entry, error) {
	var raw map[string]rawProvider
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse models.dev catalog: %w", err)
	}
	// 按 provider 名排序, 保证同一个模型 id 的取舍与遍历顺序无关。
	providers := make([]string, 0, len(raw))
	for provider := range raw {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	entries := make(map[string]Entry, len(raw)*8)
	firstParty := make(map[string]bool, len(raw)*8)
	for _, provider := range providers {
		for _, item := range raw[provider].Models {
			entry, ok := buildEntry(item)
			if !ok {
				continue
			}
			key := strings.ToLower(entry.ModelID)
			_, seen := entries[key]
			if !seen || (!firstParty[key] && firstPartyProviders[provider]) {
				entries[key] = entry
				firstParty[key] = firstPartyProviders[provider]
			}
		}
	}
	result := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].ReleaseDate != result[j].ReleaseDate {
			return result[i].ReleaseDate > result[j].ReleaseDate
		}
		return result[i].ModelID < result[j].ModelID
	})
	return result, nil
}

func buildEntry(item rawModel) (Entry, bool) {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		return Entry{}, false
	}
	identity := StrictNormalize(strings.TrimSpace(item.CanonicalModelID))
	if identity == "" {
		identity = StrictNormalize(id)
	}
	if identity == "" {
		return Entry{}, false
	}
	return Entry{
		ModelID:       id,
		Name:          strings.TrimSpace(item.Name),
		Identity:      identity,
		Developer:     Developer(item.Family),
		Family:        strings.TrimSpace(item.Family),
		ReleaseDate:   normalizeDate(item.ReleaseDate),
		ToolCall:      item.ToolCall,
		ContextWindow: item.Limit.Context,
		Status:        strings.TrimSpace(item.Status),
	}, true
}

// normalizeDate 只保留真实发布日期, 1970-01-01 这类占位值按未知处理。
func normalizeDate(raw string) string {
	date := strings.TrimSpace(raw)
	if strings.HasPrefix(date, "1970") {
		return ""
	}
	return date
}

// UpdateFromRaw 解析并落库目录数据。解析失败时不动数据库与内存快照。
// 拉取由调用方负责: 目录包不依赖网络与代理设置, 避免与 rhttp 形成循环依赖。
func UpdateFromRaw(ctx context.Context, body []byte) error {
	entries, err := Parse(body)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("models.dev catalog contains no usable model")
	}
	// 拒绝明显退化的快照: 上游被截断或改了结构时, 一次整体替换会把渠道里的模型全判成
	// 「未收录」, 开着丢弃策略就是一次性删光, 宁可继续用上一份。
	if previous := Size(); previous > 0 && len(entries)*2 < previous {
		return fmt.Errorf("refusing to replace catalog: %d models is far below the current %d", len(entries), previous)
	}
	rows := make([]model.CatalogModel, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, model.CatalogModel{
			ModelID:       entry.ModelID,
			Name:          entry.Name,
			Identity:      entry.Identity,
			Developer:     entry.Developer,
			Family:        entry.Family,
			ReleaseDate:   entry.ReleaseDate,
			ToolCall:      entry.ToolCall,
			ContextWindow: entry.ContextWindow,
			Status:        entry.Status,
		})
	}
	database := db.GetDB().WithContext(ctx)
	if err := database.Transaction(func(tx *gorm.DB) error {
		// 目录是外部数据的镜像, 每次整体替换, 避免残留已下线的模型。
		if err := tx.Exec("DELETE FROM catalog_models").Error; err != nil {
			return err
		}
		return tx.CreateInBatches(rows, 200).Error
	}); err != nil {
		return err
	}
	Replace(entries, time.Now())
	log.Infof("catalog updated: %d models", len(entries))
	return nil
}

// Load 从数据库读回目录快照, 供启动时在首次网络更新之前使用。
func Load(ctx context.Context) error {
	var rows []model.CatalogModel
	if err := db.GetDB().WithContext(ctx).Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	entries := make([]Entry, 0, len(rows))
	latest := time.Time{}
	for _, row := range rows {
		entries = append(entries, Entry{
			ModelID:       row.ModelID,
			Name:          row.Name,
			Identity:      row.Identity,
			Developer:     row.Developer,
			Family:        row.Family,
			ReleaseDate:   row.ReleaseDate,
			ToolCall:      row.ToolCall,
			ContextWindow: row.ContextWindow,
			Status:        row.Status,
		})
		if row.UpdatedAt.After(latest) {
			latest = row.UpdatedAt
		}
	}
	Replace(entries, latest)
	log.Debugf("catalog loaded from database: %d models", len(entries))
	return nil
}
