package task

import (
	"time"

	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/charmbracelet/log"
)

func Init() {
	// 注册统计保存任务
	statsSaveIntervalMinutes, err := op.SettingGetInt(model.SettingKeyStatsSaveInterval)
	if err != nil {
		log.Warnf("failed to get stats save interval: %v", err)
		return
	}
	statsSaveInterval := time.Duration(statsSaveIntervalMinutes) * time.Minute
	// 任务名与设置键一致，设置页保存后按同一个键重排周期。
	Register(string(model.SettingKeyStatsSaveInterval), statsSaveInterval, false, op.StatsSaveDBTask)
}
