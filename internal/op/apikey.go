package op

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/bestruirui/octopus/internal/db"
	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/utils/cache"
	"github.com/charmbracelet/log"
)

var apiKeyCache = cache.New[int, model.APIKey](16)
var apiKeyIDMap = cache.New[string, int](16)

// apiKeyMu 串行化缓存重建与增删改: 重建的空窗会让正常请求短暂 401,
// 与删除并发时还可能用重建前的快照把已删除的令牌写回映射。
var apiKeyMu sync.Mutex

func APIKeyCreate(key *model.APIKey, ctx context.Context) error {
	if err := db.GetDB().WithContext(ctx).Create(key).Error; err != nil {
		return fmt.Errorf("failed to create API key: %w", err)
	}
	apiKeyMu.Lock()
	defer apiKeyMu.Unlock()
	apiKeyCache.Set(key.ID, *key)
	apiKeyIDMap.Set(key.APIKey, key.ID)
	return nil
}

func APIKeyUpdate(key *model.APIKey, ctx context.Context) error {
	apiKeyMu.Lock()
	defer apiKeyMu.Unlock()

	existing, ok := apiKeyCache.Get(key.ID)
	if !ok {
		return fmt.Errorf("API key not found")
	}
	if key.APIKey == "" {
		key.APIKey = existing.APIKey
	}
	if err := db.GetDB().WithContext(ctx).Save(key).Error; err != nil {
		return fmt.Errorf("failed to update API key: %w", err)
	}
	if key.APIKey != existing.APIKey {
		apiKeyIDMap.Del(existing.APIKey)
		apiKeyIDMap.Set(key.APIKey, key.ID)
	}
	apiKeyCache.Set(key.ID, *key)
	return nil
}

// APIKeyList 返回全部 API Key, 按主键升序定序。
// 设置页不提供排序开关, 而缓存遍历顺序随机, 故顺序须由此处定稿。
func APIKeyList(ctx context.Context) ([]model.APIKey, error) {
	keys := make([]model.APIKey, 0, apiKeyCache.Len())
	for _, apiKey := range apiKeyCache.GetAll() {
		keys = append(keys, apiKey)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].ID < keys[j].ID })
	return keys, nil
}

func APIKeyGet(id int, ctx context.Context) (model.APIKey, error) {
	apiKey, ok := apiKeyCache.Get(id)
	if !ok {
		return model.APIKey{}, fmt.Errorf("API key not found")
	}
	return apiKey, nil
}

func APIKeyGetByAPIKey(apiKey string, ctx context.Context) (model.APIKey, error) {
	id, ok := apiKeyIDMap.Get(apiKey)
	if !ok {
		return model.APIKey{}, fmt.Errorf("API key not found")
	}
	return APIKeyGet(id, ctx)
}

func APIKeyDelete(id int, ctx context.Context) error {
	apiKeyMu.Lock()
	defer apiKeyMu.Unlock()

	// 从缓存取出真实令牌: 只按 ID 反查映射会得到空串, 删掉的是空键, 映射里旧令牌仍在。
	cached, ok := apiKeyCache.Get(id)
	if !ok {
		return fmt.Errorf("API key not found")
	}
	result := db.GetDB().WithContext(ctx).Delete(&model.APIKey{ID: id})
	if result.Error != nil {
		return fmt.Errorf("failed to delete API key: %w", result.Error)
	}
	// 无论库里是否还有这一行都清缓存: 行可能已被其它途径删除, 缓存里的令牌不能继续通过校验。
	apiKeyCache.Del(id)
	apiKeyIDMap.Del(cached.APIKey)
	if result.RowsAffected == 0 {
		return fmt.Errorf("API key not found")
	}
	// 统计清理失败不影响删除结果, 记日志即可。
	if err := StatsAPIKeyDel(id); err != nil {
		log.Warnf("api key %d deleted but its stats cleanup failed: %v", id, err)
	}
	return nil
}

func apiKeyRefreshCache(ctx context.Context) error {
	apiKeys := []model.APIKey{}
	if err := db.GetDB().WithContext(ctx).Find(&apiKeys).Error; err != nil {
		return err
	}

	apiKeyMu.Lock()
	defer apiKeyMu.Unlock()

	// 先清空: 缓存没有 TTL, 已删除的令牌会一直留在映射里继续通过校验。
	apiKeyCache.Clear()
	apiKeyIDMap.Clear()
	for _, apiKey := range apiKeys {
		apiKeyCache.Set(apiKey.ID, apiKey)
		apiKeyIDMap.Set(apiKey.APIKey, apiKey.ID)
	}
	return nil
}
