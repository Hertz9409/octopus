package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bestruirui/octopus/internal/model"
	"github.com/bestruirui/octopus/internal/op"
	"github.com/bestruirui/octopus/internal/server/middleware"
	"github.com/bestruirui/octopus/internal/server/resp"
	"github.com/bestruirui/octopus/internal/server/router"
	"github.com/bestruirui/octopus/internal/task"
	"github.com/charmbracelet/log"
	"github.com/gin-gonic/gin"
)

func init() {
	router.NewGroupRouter("/api/v1/setting").
		Use(middleware.Auth()).
		AddRoute(
			router.NewRoute("/list", http.MethodGet).
				Handle(getSettingList),
		).
		AddRoute(
			router.NewRoute("/set", http.MethodPost).
				Use(middleware.RequireJSON()).
				Handle(setSetting),
		).
		AddRoute(
			router.NewRoute("/export", http.MethodGet).
				Handle(exportDB),
		).
		AddRoute(
			router.NewRoute("/import", http.MethodPost).
				Handle(importDB),
		)
}

func getSettingList(c *gin.Context) {
	settings, err := op.SettingList(c.Request.Context())
	if err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Success(c, settings)
}

func setSetting(c *gin.Context) {
	var setting model.Setting
	if err := c.ShouldBindJSON(&setting); err != nil {
		resp.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	if err := setting.Validate(); err != nil {
		resp.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	// 会话签名密钥由服务端生成与轮换(改密时), 不接受外部写入。
	if setting.Key == model.SettingKeyJWTSecret {
		resp.Error(c, http.StatusBadRequest, "jwt secret is managed by the server")
		return
	}
	if err := op.SettingSetString(setting.Key, setting.Value); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	switch setting.Key {
	case model.SettingKeyStatsSaveInterval:
		minutes, err := strconv.Atoi(setting.Value)
		if err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		if !task.Update(string(setting.Key), time.Duration(minutes)*time.Minute) {
			log.Errorf("task %s not rescheduled, the new interval applies after restart", setting.Key)
		}
	}
	resp.Success(c, setting)
}

func exportDB(c *gin.Context) {
	// 先把内存里尚未落库的统计累加写库, 否则导出的统计最多落后一个保存周期。
	if err := op.SaveCache(); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	dump, err := op.DBExportAll(c.Request.Context())
	if err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}

	c.Header("Content-Type", "application/json")
	c.Header("Content-Disposition", "attachment; filename=\"octopus-export-"+time.Now().Format("20060102150405")+".json\"")
	c.JSON(http.StatusOK, dump)
}

func importDB(c *gin.Context) {
	var dump model.DBDump

	contentType := c.GetHeader("Content-Type")
	if strings.Contains(contentType, "multipart/form-data") {
		fh, err := c.FormFile("file")
		if err != nil {
			resp.Error(c, http.StatusBadRequest, "missing upload file field 'file'")
			return
		}
		f, err := fh.Open()
		if err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		defer f.Close()
		body, err := io.ReadAll(f)
		if err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := decodeDBDump(body, &dump); err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	} else {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := decodeDBDump(body, &dump); err != nil {
			resp.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	}

	for i := range dump.Groups {
		if dump.Groups[i].Mode == "" {
			dump.Groups[i].Mode = model.GroupModeManual
		}
		// 导入也是写入边界: 与创建/更新一致裁掉表达式两端空白, 免得手改过的备份带进不一致的值。
		dump.Groups[i].MatchPattern = strings.TrimSpace(dump.Groups[i].MatchPattern)
		model.NormalizeGroupRelayConfig(&dump.Groups[i].RelayConfig)
		if dump.Groups[i].Mode != model.GroupModeManual && dump.Groups[i].Mode != model.GroupModeFailover {
			resp.Error(c, http.StatusBadRequest, "invalid group relay mode")
			return
		}
	}

	// 导入也是设置写入边界: 会话签名密钥不接受覆盖, 非法值(如非数字的统计周期)要拦下,
	// 否则统计任务会因为注册失败而静默停摆。
	kept := dump.Settings[:0]
	for i := range dump.Settings {
		if dump.Settings[i].Key == model.SettingKeyJWTSecret {
			continue
		}
		if err := dump.Settings[i].Validate(); err != nil {
			log.Warnf("skip invalid setting %s in import: %v", dump.Settings[i].Key, err)
			continue
		}
		kept = append(kept, dump.Settings[i])
	}
	dump.Settings = kept

	result, err := op.DBImportIncremental(c.Request.Context(), &dump)
	if err != nil {
		resp.Error(c, http.StatusBadRequest, err.Error())
		return
	}

	if err := op.SaveCache(); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	if err := op.InitCache(); err != nil {
		resp.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	// 导入的设置可能改变了统计保存周期, 让正在跑的任务立刻改用新值。
	if minutes, err := op.SettingGetInt(model.SettingKeyStatsSaveInterval); err == nil && minutes > 0 {
		if !task.Update(string(model.SettingKeyStatsSaveInterval), time.Duration(minutes)*time.Minute) {
			log.Errorf("task %s not rescheduled after import", model.SettingKeyStatsSaveInterval)
		}
	}

	resp.Success(c, result)
}

func decodeDBDump(body []byte, dump *model.DBDump) error {
	if dump == nil {
		return json.Unmarshal(body, &struct{}{})
	}

	if err := json.Unmarshal(body, dump); err != nil {
		return err
	}

	if dump.Version == 0 &&
		len(dump.Channels) == 0 &&
		len(dump.Groups) == 0 &&
		len(dump.ChannelModels) == 0 &&
		len(dump.GroupItems) == 0 &&
		len(dump.Settings) == 0 &&
		len(dump.APIKeys) == 0 &&
		len(dump.StatsDaily) == 0 &&
		len(dump.StatsHourly) == 0 &&
		len(dump.StatsTotal) == 0 &&
		len(dump.StatsAPIKey) == 0 {
		var wrapper struct {
			Code    int             `json:"code"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(body, &wrapper); err == nil && len(wrapper.Data) > 0 {
			return json.Unmarshal(wrapper.Data, dump)
		}
	}

	return nil
}
