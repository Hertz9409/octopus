package op

import (
	"context"
	"fmt"
	"time"

	"github.com/bestruirui/octopus/internal/db"
	"github.com/bestruirui/octopus/internal/model"
	"github.com/charmbracelet/log"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 渠道拆分为渠道, 凭据, 模型与渠道授权后导出结构变化, 版本随之递增;
// 版本 5 起 api_keys.supported_models 由逗号分隔字符串改为 JSON 数组;
// 版本 6 起导出不再包含会话签名密钥, 并移除已删除的价格与模型目录字段。
const dbDumpVersion = 6

// DBExportAll 导出完整数据库内容，包括所有统计数据。
// 所有表在同一事务里读取: 逐条查询期间发生的写入会导出互相矛盾的关联数据(恢复时才以级联外键违约暴露),
// 把读取包进一个事务可以避免读到别的连接写了一半的状态。
func DBExportAll(ctx context.Context) (*model.DBDump, error) {
	conn := db.GetDB().WithContext(ctx)

	d := &model.DBDump{
		Version:    dbDumpVersion,
		ExportedAt: time.Now().UTC(),
	}

	err := conn.Transaction(func(tx *gorm.DB) error {
		if err := tx.Find(&d.Channels).Error; err != nil {
			return fmt.Errorf("export channels: %w", err)
		}
		if err := tx.Find(&d.Groups).Error; err != nil {
			return fmt.Errorf("export groups: %w", err)
		}
		if err := tx.Find(&d.ChannelKeys).Error; err != nil {
			return fmt.Errorf("export channel_keys: %w", err)
		}
		if err := tx.Find(&d.ChannelModels).Error; err != nil {
			return fmt.Errorf("export channel_models: %w", err)
		}
		if err := tx.Find(&d.ChannelGrants).Error; err != nil {
			return fmt.Errorf("export channel_grants: %w", err)
		}
		if err := tx.Find(&d.GroupItems).Error; err != nil {
			return fmt.Errorf("export group_items: %w", err)
		}
		if err := tx.Find(&d.APIKeys).Error; err != nil {
			return fmt.Errorf("export api_keys: %w", err)
		}
		if err := tx.Find(&d.Settings).Error; err != nil {
			return fmt.Errorf("export settings: %w", err)
		}
		// 会话签名密钥不进备份: 备份会被拷到别的实例, 泄露它等于让持有文件的人伪造会话令牌。
		kept := d.Settings[:0]
		for _, setting := range d.Settings {
			if setting.Key == model.SettingKeyJWTSecret {
				continue
			}
			kept = append(kept, setting)
		}
		d.Settings = kept

		if err := tx.Find(&d.StatsTotal).Error; err != nil {
			return fmt.Errorf("export stats_total: %w", err)
		}
		if err := tx.Find(&d.StatsDaily).Error; err != nil {
			return fmt.Errorf("export stats_daily: %w", err)
		}
		if err := tx.Find(&d.StatsHourly).Error; err != nil {
			return fmt.Errorf("export stats_hourly: %w", err)
		}
		if err := tx.Find(&d.StatsAPIKey).Error; err != nil {
			return fmt.Errorf("export stats_api_key: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return d, nil
}

func DBImportIncremental(ctx context.Context, dump *model.DBDump) (*model.DBImportResult, error) {
	if dump == nil {
		return nil, fmt.Errorf("empty dump")
	}

	// 只拒绝比自己更新的备份: 旧版本备份里已删除的字段会被 GORM 忽略, 仍可导入。
	if dump.Version > dbDumpVersion {
		return nil, fmt.Errorf("unsupported dump version: %d (this build supports up to %d)", dump.Version, dbDumpVersion)
	}
	if dump.Version != 0 && dump.Version < dbDumpVersion {
		log.Warnf("importing backup version %d, current version is %d", dump.Version, dbDumpVersion)
	}

	// 导入也是写入边界, 渠道配置须与接口提交走同一套规范化: 手改过的备份文件同样可能带空白,
	// 空串或缺省字段, 不在此收敛则读侧要为每个字段各自兜底。
	for i := range dump.Channels {
		config, err := normalizeChannelConfig(dump.Channels[i].ChannelConfig)
		if err != nil {
			return nil, fmt.Errorf("import channel %d: %w", dump.Channels[i].ID, err)
		}
		dump.Channels[i].ChannelConfig = config
	}

	conn := db.GetDB().WithContext(ctx)
	res := &model.DBImportResult{RowsAffected: map[string]int64{}}
	err := conn.Transaction(func(tx *gorm.DB) error {
		// base tables
		if n, err := createDoNothing(tx, dump.Channels); err != nil {
			return fmt.Errorf("import channels: %w", err)
		} else {
			res.RowsAffected["channels"] = n
		}
		// MySQL 的 INSERT IGNORE 会把同名等其它唯一键冲突也一并忽略, 父行缺失而子表照插,
		// 用户只会看到一条外键违约; 先确认父行都在, 把原因说清楚。
		if err := ensureIDsPresent(tx, &model.Channel{}, channelIDs(dump.Channels), "channels"); err != nil {
			return err
		}
		// 渠道按主键冲突跳过, 统计需单独覆盖; 凭据与模型走整行覆盖, 统计随行一并导入。
		for _, channel := range dump.Channels {
			if err := tx.Model(&model.Channel{}).
				Where("id = ?", channel.ID).
				Select("input_token", "output_token", "wait_time", "request_success", "request_failed").
				Updates(&channel).Error; err != nil {
				return fmt.Errorf("import channel stats: %w", err)
			}
		}
		if n, err := createDoNothing(tx, dump.Groups); err != nil {
			return fmt.Errorf("import groups: %w", err)
		} else {
			res.RowsAffected["groups"] = n
		}
		if err := ensureIDsPresent(tx, &model.Group{}, groupIDs(dump.Groups), "groups"); err != nil {
			return err
		}
		if n, err := createUpsertAll(tx, dump.ChannelKeys, []clause.Column{{Name: "id"}}); err != nil {
			return fmt.Errorf("import channel_keys: %w", err)
		} else {
			res.RowsAffected["channel_keys"] = n
		}
		if n, err := createUpsertAll(tx, dump.ChannelModels, []clause.Column{{Name: "id"}}); err != nil {
			return fmt.Errorf("import channel_models: %w", err)
		} else {
			res.RowsAffected["channel_models"] = n
		}
		if n, err := createUpsertAll(tx, dump.ChannelGrants, []clause.Column{{Name: "id"}}); err != nil {
			return fmt.Errorf("import channel_grants: %w", err)
		} else {
			res.RowsAffected["channel_grants"] = n
		}
		if n, err := createDoNothing(tx, dump.GroupItems); err != nil {
			return fmt.Errorf("import group_items: %w", err)
		} else {
			res.RowsAffected["group_items"] = n
		}
		if n, err := createDoNothing(tx, dump.APIKeys); err != nil {
			return fmt.Errorf("import api_keys: %w", err)
		} else {
			res.RowsAffected["api_keys"] = n
		}
		if n, err := createUpsertSettings(tx, dump.Settings); err != nil {
			return fmt.Errorf("import settings: %w", err)
		} else {
			res.RowsAffected["settings"] = n
		}

		if n, err := createUpsertAll(tx, dump.StatsTotal, []clause.Column{{Name: "id"}}); err != nil {
			return fmt.Errorf("import stats_total: %w", err)
		} else {
			res.RowsAffected["stats_total"] = n
		}
		if n, err := createUpsertAll(tx, dump.StatsDaily, []clause.Column{{Name: "date"}}); err != nil {
			return fmt.Errorf("import stats_daily: %w", err)
		} else {
			res.RowsAffected["stats_daily"] = n
		}
		if n, err := createUpsertAll(tx, dump.StatsHourly, []clause.Column{{Name: "hour"}}); err != nil {
			return fmt.Errorf("import stats_hourly: %w", err)
		} else {
			res.RowsAffected["stats_hourly"] = n
		}
		if n, err := createUpsertAll(tx, dump.StatsAPIKey, []clause.Column{{Name: "api_key_id"}}); err != nil {
			return fmt.Errorf("import stats_api_key: %w", err)
		} else {
			res.RowsAffected["stats_api_key"] = n
		}

		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// batchSize 控制每次 INSERT 的最大行数。
// 单行字段数较多（如 stats_hourly 含 9 个字段），若一次插入过多行会超过数据库绑定参数上限（SQLite/PostgreSQL 为 65535），按行数分批写入可规避该限制。
const batchSize = 2000

// createDoNothing 以主键为冲突目标插入: 不指定目标列时数据库会把唯一索引冲突也一并忽略,
// 于是父表行被静默跳过而子表按备份里的主键插入, 最终以级联外键违约整单失败。
func createDoNothing[T any](tx *gorm.DB, rows []T) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	result := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoNothing: true,
	}).CreateInBatches(&rows, batchSize)
	return result.RowsAffected, result.Error
}

func createUpsertAll[T any](tx *gorm.DB, rows []T, columns []clause.Column) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	result := tx.Clauses(clause.OnConflict{
		Columns:   columns,
		UpdateAll: true,
	}).CreateInBatches(&rows, batchSize)
	return result.RowsAffected, result.Error
}

func createUpsertSettings(tx *gorm.DB, rows []model.Setting) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	result := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(&rows)
	return result.RowsAffected, result.Error
}

// ensureIDsPresent 确认这些主键在表里真的存在。
// 父表按主键冲突跳过时, 某些数据库(MySQL 的 INSERT IGNORE)会把其它唯一键冲突一起忽略,
// 于是父行没写上而子表照插, 最终只暴露一条难以理解的外键违约; 这里提前给出可读原因。
func ensureIDsPresent(tx *gorm.DB, table any, ids []int, label string) error {
	if len(ids) == 0 {
		return nil
	}
	var found []int
	if err := tx.Model(table).Where("id IN ?", ids).Pluck("id", &found).Error; err != nil {
		return fmt.Errorf("verify %s after import: %w", label, err)
	}
	if len(found) == len(ids) {
		return nil
	}
	present := make(map[int]struct{}, len(found))
	for _, id := range found {
		present[id] = struct{}{}
	}
	missing := make([]int, 0, len(ids)-len(found))
	for _, id := range ids {
		if _, ok := present[id]; !ok {
			missing = append(missing, id)
		}
	}
	return fmt.Errorf("import %s: ids %v are missing after insert; a row with the same unique key (such as name) already exists with another id, import into a fresh instance or rename it", label, missing)
}

func channelIDs(channels []model.Channel) []int {
	ids := make([]int, 0, len(channels))
	for i := range channels {
		ids = append(ids, channels[i].ID)
	}
	return ids
}

func groupIDs(groups []model.Group) []int {
	ids := make([]int, 0, len(groups))
	for i := range groups {
		ids = append(ids, groups[i].ID)
	}
	return ids
}
