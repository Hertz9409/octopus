package model

import "time"

// CatalogModel 是 models.dev 目录中的一个模型条目。
// 只承载筛选需要的元数据, 与按渠道引用清理的价格表分开存放, 避免被 LLMCleanupGhosts 删掉。
type CatalogModel struct {
	ID            uint      `json:"id" gorm:"primaryKey"`
	ModelID       string    `json:"model_id" gorm:"uniqueIndex;not null"` // 目录里的原始 id
	Name          string    `json:"name"`                                 // 展示名
	Identity      string    `json:"identity" gorm:"index"`                // 归一化后的模型身份, 同一模型的多种写法共用
	Developer     string    `json:"developer" gorm:"index"`               // 研发商展示名, 未识别为「其他」
	Family        string    `json:"family"`                               // 目录里的 family
	ReleaseDate   string    `json:"release_date" gorm:"index"`            // YYYY-MM-DD
	ToolCall      bool      `json:"tool_call"`                            // 是否支持工具调用
	ContextWindow int       `json:"context_window"`                       // 上下文上限, 0 表示目录未提供
	Status        string    `json:"status"`                               // deprecated/beta/alpha, 空表示正式
	UpdatedAt     time.Time `json:"updated_at"`
}

// CatalogModelItem 是模型库页面的一行: 渠道在售的模型加上目录元数据与规则判定结果。
type CatalogModelItem struct {
	ModelID     string   `json:"model_id"`     // 用于展示的规范模型名
	Identity    string   `json:"identity"`     // 归并后的模型身份
	Developer   string   `json:"developer"`    // 研发商展示名
	ReleaseDate string   `json:"release_date"` // 发布时间
	ToolCall    bool     `json:"tool_call"`
	Context     int      `json:"context_window"`
	Status      string   `json:"status"`
	Channels    []string `json:"channels"`  // 引用该模型的渠道名
	RawNames    []string `json:"raw_names"` // 渠道里的原始模型名, 含中转站变体
	Matched     bool     `json:"matched"`   // 是否在目录里找到
}

// CatalogSummary 是模型库页面的汇总信息。
// CatalogSummary 只带页面真正渲染的信息: 渠道在售模型行数由 items 长度得出, 规则判定由前端按未保存的规则自己算。
type CatalogSummary struct {
	CatalogCount int `json:"catalog_count"` // 目录里的模型身份总数, 为 0 时后端会保守地不过滤任何模型
	CatalogSize  int `json:"catalog_size"`  // 目录里的原始模型条目数
	UpdatedAt    int `json:"updated_at"`    // 目录最近一次更新时间(Unix 秒), 0 表示未更新
}
