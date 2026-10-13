package model

import (
	"fmt"
	"net/url"
	"strconv"

	"github.com/dlclark/regexp2"
)

type SettingKey string

const (
	SettingKeyProxyURL                SettingKey = "proxy_url"
	SettingKeyStatsSaveInterval       SettingKey = "stats_save_interval"        // 将统计信息写入数据库的周期(分钟)
	SettingKeyModelInfoUpdateInterval SettingKey = "model_info_update_interval" // 模型信息更新间隔(小时)
	SettingKeyCORSAllowOrigins        SettingKey = "cors_allow_origins"         // 跨域白名单(逗号分隔, 如 "example.com,example2.com"). 为空不允许跨域, "*"允许所有
	SettingKeyModelFilter             SettingKey = "model_filter"              // 渠道获取模型时的全局过滤表达式; 留空表示不过滤
	// 模型库规则: 渠道同步模型时按 models.dev 目录元数据过滤, 全部默认关闭或宽松, 保持原有行为。
	SettingKeyCatalogFilterEnabled  SettingKey = "catalog_filter_enabled"    // 是否按目录规则过滤
	SettingKeyCatalogReleaseDays    SettingKey = "catalog_release_days"      // 只保留最近 N 天发布的模型; 0 表示不限
	SettingKeyCatalogRequireTool    SettingKey = "catalog_require_tool_call" // 只保留支持工具调用的模型
	SettingKeyCatalogMinContext     SettingKey = "catalog_min_context"       // 上下文下限; 0 表示不限
	SettingKeyCatalogDropDeprecated SettingKey = "catalog_drop_deprecated"   // 排除目录里已标记弃用的模型
	SettingKeyCatalogUnknownPolicy  SettingKey = "catalog_unknown_policy"    // 目录里没有的模型: keep 保留 / drop 丢弃
)

type Setting struct {
	Key   SettingKey `json:"key" gorm:"primaryKey"`
	Value string     `json:"value" gorm:"not null"`
}

func DefaultSettings() []Setting {
	return []Setting{
		{Key: SettingKeyProxyURL, Value: ""},
		{Key: SettingKeyStatsSaveInterval, Value: "10"},       // 默认10分钟保存一次统计信息
		{Key: SettingKeyCORSAllowOrigins, Value: ""},          // CORS 默认不允许跨域，设置为 "*" 才允许所有来源
		{Key: SettingKeyModelInfoUpdateInterval, Value: "24"}, // 默认24小时更新一次模型信息
		{Key: SettingKeyModelFilter, Value: ""},               // 默认不过滤模型
		// 模型库规则默认关闭, 开启后按目录元数据过滤渠道同步出来的模型。
		{Key: SettingKeyCatalogFilterEnabled, Value: "false"},
		{Key: SettingKeyCatalogReleaseDays, Value: "0"},
		{Key: SettingKeyCatalogRequireTool, Value: "false"},
		{Key: SettingKeyCatalogMinContext, Value: "0"},
		{Key: SettingKeyCatalogDropDeprecated, Value: "true"},
		{Key: SettingKeyCatalogUnknownPolicy, Value: "keep"},
	}
}

func (s *Setting) Validate() error {
	switch s.Key {
	case SettingKeyStatsSaveInterval:
		minutes, err := strconv.Atoi(s.Value)
		if err != nil {
			return fmt.Errorf("stats save interval must be an integer")
		}
		if minutes <= 0 {
			return fmt.Errorf("stats save interval must be greater than 0")
		}
		return nil
	case SettingKeyModelInfoUpdateInterval:
		hours, err := strconv.Atoi(s.Value)
		if err != nil {
			return fmt.Errorf("model info update interval must be an integer")
		}
		// 0 或负数会让目录更新任务被直接删掉, 之后模型目录再也不刷新。
		if hours <= 0 {
			return fmt.Errorf("model info update interval must be greater than 0")
		}
		return nil
	case SettingKeyModelFilter:
		if s.Value == "" {
			return nil
		}
		// 与渠道侧一致用 ECMAScript 方言校验, 避免设置能存但探测时编译失败。
		if _, err := regexp2.Compile(s.Value, regexp2.ECMAScript); err != nil {
			return fmt.Errorf("model filter regex is invalid: %w", err)
		}
		return nil
	case SettingKeyProxyURL:
		if s.Value == "" {
			return nil
		}
		parsedURL, err := url.Parse(s.Value)
		if err != nil {
			return fmt.Errorf("proxy URL is invalid: %w", err)
		}
		validSchemes := map[string]bool{
			"http":    true,
			"https":   true,
			"socks5":  true,
			"socks5h": true,
		}
		if !validSchemes[parsedURL.Scheme] {
			return fmt.Errorf("proxy URL scheme must be http, https, socks5, or socks5h")
		}
		if parsedURL.Host == "" {
			return fmt.Errorf("proxy URL must have a host")
		}
		return nil
	case SettingKeyCatalogFilterEnabled, SettingKeyCatalogRequireTool, SettingKeyCatalogDropDeprecated:
		if _, err := strconv.ParseBool(s.Value); err != nil {
			return fmt.Errorf("%s must be a boolean", s.Key)
		}
		return nil
	case SettingKeyCatalogReleaseDays, SettingKeyCatalogMinContext:
		value, err := strconv.Atoi(s.Value)
		if err != nil {
			return fmt.Errorf("%s must be an integer", s.Key)
		}
		if value < 0 {
			return fmt.Errorf("%s must not be negative", s.Key)
		}
		return nil
	case SettingKeyCatalogUnknownPolicy:
		if s.Value != "keep" && s.Value != "drop" {
			return fmt.Errorf("catalog unknown policy must be keep or drop")
		}
		return nil
	}

	return nil
}
